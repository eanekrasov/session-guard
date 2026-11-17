import type { Hooks } from '@opencode-ai/plugin';
import type { UserMessage } from '@opencode-ai/sdk';
import type { OpenCodeRulesRuntime, V2DeliverySink } from './orchestrator.js';
import type { RuntimePort, ReadHistory } from './runtime-port.js';
import type { RawHistoryResult } from '../delivery/rule-delivery-history.js';
import type { DeliveryPart } from '../delivery/rule-delivery-codec.js';

type Hook = (input: never, output?: never) => Promise<void> | void;
type HookRegistration = { dispose(): Promise<void> };
type AdaptedHookName =
  | 'tool.execute.before'
  | 'tool.execute.after'
  | 'chat.message'
  | 'experimental.chat.messages.transform'
  | 'event';
type HookArguments<Name extends AdaptedHookName> = Parameters<NonNullable<Hooks[Name]>>;

/**
 * V1 host shapes for tool hooks (mirrors app/runtime.ts handleToolBefore/
 * handleToolAfter). The core consumes the v2 contract ({ tool, sessionID, id,
 * input, status, result }); wireV1Rules converts so observations survive.
 * before: args ride the output, after: args ride the input.
 */
interface V1ToolBeforeInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
  agent?: string;
  messageID?: string;
}
interface V1ToolAfterInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
  args?: unknown;
}
interface V1ToolAfterOutput {
  title?: string;
  output?: string;
  metadata?: unknown;
}
type ChatMessageOutput = HookArguments<'chat.message'>[1];
type TransformMessage =
  HookArguments<'experimental.chat.messages.transform'>[1]['messages'][number];
type UserTransformMessage = TransformMessage & { info: UserMessage };

interface ContextMessage {
  id?: string;
  role?: string;
  content?: unknown[];
}

/**
 * V1 implementation of the rules engine port over the V1 hooks facade.
 * Durable admission appends a synthetic text part to the in-flight
 * `chat.message` output; transient context uses the messages-transform hook
 * output. History/tool RPCs that V1 exposes via `pluginInput.client` are
 * surfaced through a small client accessor (callers may leave it absent).
 */
export function createV1RuntimePort(options: {
  hooks: Hooks;
  /** Optional V1 client (`pluginInput.client`) for history / tool IDs. */
  client?: {
    session?: {
      messages?: (input: {
        path: { id: string };
        query?: { directory?: string };
      }) => Promise<{ data?: unknown }>;
    };
    tool?: {
      ids?: (input: { query: { directory: string } }) => Promise<{ data?: string[] }>;
    };
  } | null;
  directory?: string;
}): RuntimePort {
  const { hooks, client, directory } = options;
  // Lazily captured output of the last Fired chat.message; `synthetic` appends
  // into it, mirroring wireV1Rules' internal chatOutput.
  let chatOutput: ChatMessageOutput | undefined;
  const originalChatMessage = hooks['chat.message'];

  // Wrap chat.message so synthetic parts land in the current output.
  if (typeof originalChatMessage === 'function' && !Reflect.get(hooks, '__sgPortWrapped')) {
    Reflect.set(hooks, '__sgPortWrapped', true);
    Reflect.set(hooks, 'chat.message', async (input: never, output: ChatMessageOutput) => {
      chatOutput = output;
      try {
        return await Reflect.apply(originalChatMessage, undefined, [input, output]);
      } finally {
        chatOutput = undefined;
      }
    });
  }

  const persistViaChat = async (sessionID: string, part: DeliveryPart): Promise<void> => {
    const output = chatOutput;
    if (!output || part.type !== 'text' || typeof part.text !== 'string') {
      throw new Error('V1 chat.message output is unavailable');
    }
    output.parts.push({
      id: part.id ?? `prt_rules_${sessionID}`,
      sessionID,
      messageID: output.message?.id as string | undefined,
      type: 'text',
      text: part.text,
      synthetic: true,
      ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
    } as never);
  };

  const readHistory: ReadHistory = async (sessionID: string): Promise<RawHistoryResult> => {
    const messages = client?.session?.messages;
    if (!messages) return { ok: true, messages: [] };
    try {
      const data = await messages({
        path: { id: sessionID },
        query: directory ? { directory } : undefined,
      });
      const list = data?.data;
      return { ok: true, messages: Array.isArray(list) ? list : [] };
    } catch {
      return { ok: false };
    }
  };

  const queryAvailableToolIDs = async (contextToolIDs?: readonly string[]): Promise<string[]> => {
    const ids = new Set<string>(contextToolIDs ?? []);
    if (client?.tool?.ids && directory) {
      try {
        const result = await client.tool.ids({ query: { directory } });
        const data = result?.data;
        if (Array.isArray(data)) for (const id of data) ids.add(id);
      } catch {
        // tool.ids is best-effort; contextToolIDs still apply.
      }
    }
    return Array.from(ids);
  };

  return {
    persistAdmission: persistViaChat,
    readHistory,
    queryAvailableToolIDs,
    // V1 delivers durable rules by appending synthetic parts to chat.message;
    // the port routes there via persistAdmission. synthetic stays absent so
    // the core's durable turn falls back to the persistAdmission path.
  };
}

/** Bridges the upstream runtime's V2 hook contract to OpenCode's V1 hooks. */
export async function wireV1Rules(
  runtime: Pick<OpenCodeRulesRuntime, 'wire'>,
  hooks: Hooks
): Promise<() => Promise<void>> {
  const callbacks = new Map<string, Hook>();
  let chatOutput: ChatMessageOutput | undefined;
  const registrations: HookRegistration[] = [];
  const eventQueue: Array<{ type?: string; data?: { sessionID?: unknown } }> = [];
  let wake: (() => void) | undefined;

  const context: Parameters<OpenCodeRulesRuntime['wire']>[0] = {
    tool: {
      hook: async (name: string, handler: Hook) => {
        callbacks.set(`tool.${name}`, handler);
        return {
          dispose: async () => {
            callbacks.delete(`tool.${name}`);
          },
        };
      },
    },
    session: {
      hook: async (name: string, handler: Hook) => {
        callbacks.set(`session.${name}`, handler);
        return {
          dispose: async () => {
            callbacks.delete(`session.${name}`);
          },
        };
      },
      synthetic: async (input: Parameters<V2DeliverySink['synthetic']>[0]) => {
        const output = chatOutput;
        if (!output) return;
        output.parts.push({
          id: input.id,
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: 'text',
          text: input.text,
          synthetic: true,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        });
      },
    },
    event: {
      async *subscribe({ signal }: { signal?: AbortSignal } = {}) {
        while (!signal?.aborted) {
          if (eventQueue.length > 0) {
            yield eventQueue.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      },
    },
  };

  const cleanup = await runtime.wire(context);
  const invoke = async (name: string, input: unknown, output?: unknown) => {
    // Runtime hook names select different host payload pairs; the map erases that correlation.
    await callbacks.get(name)?.(input as never, output as never);
  };
  const install = <Name extends AdaptedHookName>(
    name: Name,
    handler: (...args: HookArguments<Name>) => Promise<void>
  ) => {
    const original = Reflect.get(hooks, name);
    if (typeof original !== 'function') return;
    const wrapped = (...args: HookArguments<Name>) =>
      Promise.resolve(Reflect.apply(original, undefined, args)).then(() =>
        Reflect.apply(handler, undefined, args)
      );
    Reflect.set(hooks, name, wrapped);
    registrations.push({
      dispose: async () => {
        if (Reflect.get(hooks, name) === wrapped) Reflect.set(hooks, name, original);
      },
    });
  };

  install('tool.execute.before', async (input, output) => {
    const { tool, sessionID, callID, agent, messageID } = input as never as V1ToolBeforeInput;
    await invoke('tool.execute.before', {
      tool,
      sessionID,
      ...(agent !== undefined ? { agent } : {}),
      ...(messageID !== undefined ? { messageID } : {}),
      id: callID,
      input: (output as { args?: unknown }).args,
    });
  });
  install('tool.execute.after', async (input, output) => {
    const { tool, sessionID, callID, args } = input as never as V1ToolAfterInput;
    const result = output as V1ToolAfterOutput;
    await invoke('tool.execute.after', {
      tool,
      sessionID,
      id: callID,
      input: args,
      // The V1 host only fires the after hook for completed executions, so the
      // v2 "completed" gate is satisfied by construction.
      status: 'completed',
      result: {
        ...(typeof result.output === 'string' ? { output: result.output } : {}),
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      },
    });
  });
  install('chat.message', async (input, output) => {
    chatOutput = output;
    try {
      const parts = output.parts;
      const text = parts
        .filter((part) => part.type === 'text' && !part.synthetic)
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      await invoke('session.prompt', {
        sessionID: input.sessionID,
        messageID: input.messageID ?? output.message.id,
        prompt: { text },
      });
    } finally {
      chatOutput = undefined;
    }
    await invoke('chat.message', input, output);
  });
  install('experimental.chat.messages.transform', async (_input, output) => {
    const source = Array.isArray(output.messages) ? output.messages : [];
    const normalized = source.map(toContextMessage);
    const originalLength = normalized.length;
    const userMessage = source.find(
      (message): message is UserTransformMessage => message.info.role === 'user'
    );
    const sessionID = userMessage?.info.sessionID ?? source[0]?.info.sessionID;
    // V1 user messages carry the agent/model on the message info; the v2
    // context hook reads them from the top-level input, so hoist them here
    // (like chat-capture) with the V1 model shape mapped to the V2 Model.Ref.
    const info = userMessage?.info;
    await invoke('session.context', {
      sessionID,
      ...(info?.agent !== undefined ? { agent: info.agent } : {}),
      ...(info?.model?.modelID !== undefined
        ? { model: { providerID: info.model.providerID, id: info.model.modelID } }
        : {}),
      messages: normalized,
    });
    output.messages = [
      ...source,
      ...normalized
        .slice(originalLength)
        .map((message) => toLegacyMessage(message, userMessage?.info))
        .filter((message): message is TransformMessage => message !== undefined),
    ];
  });
  install('event', async (event) => {
    const properties = event.event.properties;
    eventQueue.push({
      type: event.event.type,
      data: {
        sessionID: properties && 'sessionID' in properties ? properties.sessionID : undefined,
      },
    });
    wake?.();
    wake = undefined;
  });

  return async () => {
    await cleanup();
    for (const registration of registrations.reverse()) await registration.dispose();
  };
}

function toContextMessage(message: TransformMessage): ContextMessage {
  return {
    ...(message.info.id ? { id: message.info.id } : {}),
    role: message.info.role ?? 'user',
    content: (message.parts ?? []).flatMap<Record<string, unknown>>((part) => {
      if (part.type === 'text' && part.synthetic) return [];
      if (part.type === 'tool') {
        return [
          {
            type: 'tool-call',
            name: part.tool,
            input: part.state.input,
          },
        ];
      }
      return [{ ...part }];
    }),
  };
}

function toLegacyMessage(
  message: ContextMessage,
  userInfo: UserMessage | undefined
): TransformMessage | undefined {
  if (!userInfo || typeof message.id !== 'string' || message.role !== 'user') return undefined;
  const messageID = message.id;

  return {
    info: { ...userInfo, id: messageID },
    parts: (message.content ?? []).flatMap((part, index) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        Array.isArray(part) ||
        !('type' in part) ||
        part.type !== 'text' ||
        !('text' in part) ||
        typeof part.text !== 'string'
      ) {
        return [];
      }

      return [
        {
          id: `${messageID}_part_${index}`,
          sessionID: userInfo.sessionID,
          messageID,
          type: 'text',
          text: part.text,
          synthetic: true,
          ...('metadata' in part && isRecord(part.metadata) ? { metadata: part.metadata } : {}),
        },
      ];
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
