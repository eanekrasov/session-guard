import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
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
      'workflow-list is registered through ctx.tool.transform with a V2 JSON schema and read-only Effect result.',
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
    status: 'deferred',
    reason: 'The V2 event subscription mapping is not part of V2.1/V2.2.',
  },
  {
    name: 'Chat message processing',
    v1Hook: 'chat.message',
    v2Mapping: 'No confirmed V2 equivalent',
    status: 'deferred',
    reason: 'No equivalent is claimed until the installed contract is mapped explicitly.',
  },
  {
    name: 'Compaction',
    v1Hook: 'experimental.session.compacting',
    v2Mapping: 'No confirmed V2 equivalent',
    status: 'deferred',
    reason: 'No equivalent is claimed until the installed contract is mapped explicitly.',
  },
  {
    name: 'Message transform',
    v1Hook: 'experimental.chat.messages.transform',
    v2Mapping: 'No confirmed V2 equivalent',
    status: 'deferred',
    reason: 'No equivalent is claimed until the installed contract is mapped explicitly.',
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
