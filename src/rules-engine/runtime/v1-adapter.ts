import type { Hooks } from '@opencode-ai/plugin';
import type { UserMessage } from '@opencode-ai/sdk';
import type { OpenCodeRulesRuntime, V2DeliverySink } from './orchestrator.js';

type Hook = (input: never, output?: never) => Promise<void> | void;
type HookRegistration = { dispose(): Promise<void> };
type AdaptedHookName =
  | 'tool.execute.before'
  | 'tool.execute.after'
  | 'chat.message'
  | 'experimental.chat.messages.transform'
  | 'event';
type HookArguments<Name extends AdaptedHookName> = Parameters<NonNullable<Hooks[Name]>>;
type ChatMessageOutput = HookArguments<'chat.message'>[1];
type TransformMessage =
  HookArguments<'experimental.chat.messages.transform'>[1]['messages'][number];
type UserTransformMessage = TransformMessage & { info: UserMessage };

interface ContextMessage {
  id?: string;
  role?: string;
  content?: unknown[];
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

  install('tool.execute.before', async (input, output) =>
    invoke('tool.execute.before', input, output)
  );
  install('tool.execute.after', async (input, output) =>
    invoke('tool.execute.after', input, output)
  );
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
    await invoke('session.context', {
      sessionID,
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
