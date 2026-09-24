import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import type { Message } from '@opencode/ai';
import type { Tool } from '@opencode/schema/tool';
import type { ResolveParentFn } from './session-executor.ts';

export interface V2RuntimeContract {
  readonly projectDirectory: string;
  readonly worktreeDirectory: string;
  readonly profileDirectory: string;
  readonly sessionStoreDirectory: string;
  readonly toolExecution: {
    readonly before: V2ToolBeforeEvent;
    readonly after: V2ToolAfterEvent;
  };
}

export interface V2ToolBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly callID: string;
  readonly input: unknown;
}

export type V2ToolAfterEvent = V2ToolBeforeEvent &
  (
    | { readonly status: 'completed'; readonly result: Tool.Result }
    | { readonly status: 'error'; readonly error: Tool.Error }
  );

export type V2CapabilityStatus = 'supported' | 'deferred' | 'out-of-scope';

export interface V2Capability {
  readonly name: string;
  readonly v1Hook: string;
  readonly v2Mapping: string;
  readonly status: V2CapabilityStatus;
  readonly reason: string;
  readonly testPath?: string;
}

export const V2_CAPABILITIES: readonly V2Capability[] = [
  {
    name: 'Tool before policy',
    v1Hook: 'tool.execute.before',
    v2Mapping: "ctx.tool.hook('execute.before')",
    status: 'supported',
    reason:
      'The adapter preserves tool, session, call, input, agent, and message identity and propagates policy rejection.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Tool after lifecycle',
    v1Hook: 'tool.execute.after',
    v2Mapping: "ctx.tool.hook('execute.after')",
    status: 'supported',
    reason:
      'Completed results are sanitized before shared processing; errors use an explicit failure closure without success processing.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Custom workflow tools',
    v1Hook: 'hooks.tool',
    v2Mapping: 'ctx.tool.transform',
    status: 'supported',
    reason:
      'The seven V1 workflow tools are registered through ctx.tool.transform with V2 JSON schemas and shared behavior; broader V1 parity is not claimed.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Session parent lookup',
    v1Hook: 'V1 client session API',
    v2Mapping: 'ctx.session.get({ sessionID })',
    status: 'supported',
    reason:
      'The adapter projects non-empty parentID values through the shared resolver; failed lookups remain retryable.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Host events',
    v1Hook: 'event',
    v2Mapping: 'ctx.event.subscribe',
    status: 'supported',
    reason:
      'The AsyncIterable stream forwards only message.removed and message.part.updated in the legacy event shape; unrelated host events are ignored.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Chat message processing',
    v1Hook: 'chat.message',
    v2Mapping: "ctx.session.hook('prompt')",
    status: 'supported',
    reason:
      'The prompt hook preserves session and message identity and forwards mutable prompt text to shared chat processing.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Compaction',
    v1Hook: 'experimental.session.compacting',
    v2Mapping: "ctx.session.hook('compaction')",
    status: 'deferred',
    reason: 'V2 compaction exposes a result override, not the V1 mutable context/prompt output.',
  },
  {
    name: 'Message transform',
    v1Hook: 'experimental.chat.messages.transform',
    v2Mapping: "ctx.session.hook('context')",
    status: 'supported',
    reason:
      'The adapter forwards V2 context messages through the existing V1 transform with explicit session identity and converts proven text/tool-call fields back to the V2 Message shape.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
  {
    name: 'Generate',
    v1Hook: 'No V1 equivalent',
    v2Mapping: "ctx.session.hook('generate')",
    status: 'deferred',
    reason:
      'V2 generate has no V1 handler or mutable output contract with established semantic parity.',
  },
  {
    name: 'Runtime disposal',
    v1Hook: 'dispose',
    v2Mapping: 'setup cleanup and Registration.dispose',
    status: 'supported',
    reason: 'The installed contract exposes setup Cleanup and disposable registrations.',
    testPath: 'test/app/v2-plugin-adapter.test.ts',
  },
];

export interface V2ToolRegistration {
  readonly registration: Registration;
  readonly dispose: () => Promise<void>;
}

export type V2HostEvent = {
  readonly id: string;
  readonly created: number;
  readonly durable: {
    readonly aggregateID: string;
    readonly seq: number;
    readonly version: number;
  };
} & (
  | {
      readonly type: 'message.removed';
      readonly data: { readonly sessionID: string; readonly messageID: string };
    }
  | {
      readonly type: 'message.part.updated';
      readonly data: { readonly sessionID: string; readonly part: unknown };
    }
);

/** Map a supported V2 event to the legacy event shape consumed by handleEvent. */
export function v2HostEvent(event: V2HostEvent): {
  event:
    | { type: 'message.removed'; properties: { sessionID: string; messageID: string } }
    | { type: 'message.part.updated'; properties: { sessionID: string; part: unknown } };
} {
  if (event.type === 'message.removed') {
    return {
      event: {
        type: event.type,
        properties: { sessionID: event.data.sessionID, messageID: event.data.messageID },
      },
    };
  }

  return {
    event: {
      type: event.type,
      properties: { sessionID: event.data.sessionID, part: event.data.part },
    },
  };
}

export interface V2ContextEvent {
  readonly sessionID: string;
  readonly model: unknown;
  system: Array<{ type: 'text'; text: string }>;
  messages: Message[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly agent: string;
}

export function v2ContextEvent(event: V2ContextEvent): {
  readonly input: { sessionID: string; model: unknown };
  readonly output: {
    system: string[];
    messages: import('../rules/message-context.js').MessageWithInfo[];
  };
} {
  return {
    input: { sessionID: event.sessionID, model: event.model },
    output: {
      system: event.system.map((part) => part.text),
      messages: event.messages.map((message) => ({
        info: { id: message.id, role: message.role, sessionID: event.sessionID },
        parts: message.content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'tool-call') {
            return {
              type: 'tool-invocation',
              toolInvocation: { toolName: part.name, args: part.input },
            };
          }
          return { type: part.type };
        }),
      })),
    },
  };
}

export function v2MessagesFromLegacy(
  messages: import('../rules/message-context.js').MessageWithInfo[],
  sessionID: string
): Message[] {
  return messages.flatMap((message) => {
    const role = message.info?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      return [];
    }
    const content = (message.parts ?? [])
      .filter(
        (part): part is { type: 'text'; text: string; synthetic?: boolean } =>
          part.type === 'text' && typeof part.text === 'string'
      )
      .map((part) => ({
        type: 'text' as const,
        text: part.text,
        ...(part.synthetic ? { metadata: { synthetic: true, sessionID } } : {}),
      }));
    return content.length > 0 ? [{ id: message.info?.id, role, content } as Message] : [];
  });
}

interface V2SessionLookup {
  get(
    input: Parameters<Context['session']['get']>[0],
    requestOptions?: Parameters<Context['session']['get']>[1]
  ): ReturnType<Context['session']['get']>;
}

/**
 * Projects V2's typed session lookup onto the host-neutral parent resolver
 * used by the shared executor. Lookup failures intentionally propagate so the
 * executor can avoid caching an unproven self-root fallback.
 */
export function v2ParentResolver(session: V2SessionLookup): ResolveParentFn {
  return async (sessionID) => {
    const { parentID } = await session.get({ sessionID });
    return typeof parentID === 'string' && parentID !== '' ? parentID : null;
  };
}

export function v2ProjectDirectory(context: Context): string {
  return context.location.project.directory;
}

export function v2PromptEvent(event: {
  readonly sessionID: string;
  readonly messageID: string;
  readonly prompt: { text: string };
}): {
  readonly input: { sessionID: string; messageID: string };
  readonly output: {
    message: { id: string; role: 'user' };
    parts: [{ type: 'text'; text: string }];
  };
} {
  return {
    input: { sessionID: event.sessionID, messageID: event.messageID },
    output: {
      message: { id: event.messageID, role: 'user' },
      parts: [{ type: 'text', text: event.prompt.text }],
    },
  };
}

export function v2WorktreeDirectory(context: Context): string {
  return context.location.directory;
}

/**
 * Maps exactly the identity required by V2's execute.before hook. The runtime
 * does not currently consume agent or message identity, but retaining it here
 * prevents the adapter boundary from silently losing host information.
 */
export function v2ToolBeforeEvent(event: {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
}): V2ToolBeforeEvent {
  return {
    tool: event.tool,
    sessionID: event.sessionID,
    agent: event.agent,
    messageID: event.messageID,
    callID: event.id,
    input: event.input,
  };
}

function textOutput(result: Tool.Result): string {
  if (typeof result.output === 'string') return result.output;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .filter(
        (content): content is Extract<Tool.Content, { type: 'text' }> => content.type === 'text'
      )
      .map((content) => content.text)
      .join('\n');
  }
  return '';
}

export function v2ToolAfterEvent(
  event: {
    readonly tool: string;
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
    readonly id: string;
    readonly input: unknown;
  } & (
    | { readonly status: 'completed'; readonly result: Tool.Result }
    | { readonly status: 'error'; readonly error: Tool.Error }
  )
): V2ToolAfterEvent {
  const identity = v2ToolBeforeEvent(event);
  if (event.status === 'completed') {
    return {
      ...identity,
      status: 'completed',
      result: {
        output: textOutput(event.result),
        metadata: event.result.metadata,
      },
    };
  }
  return { ...identity, status: 'error', error: event.error };
}
