import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import type { Tool } from '@opencode/schema/tool';

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
}

export const V2_CAPABILITIES: readonly V2Capability[] = [
  {
    name: 'Tool before policy',
    v1Hook: 'tool.execute.before',
    v2Mapping: "ctx.tool.hook('execute.before')",
    status: 'supported',
    reason:
      'The adapter preserves tool, session, call, input, agent, and message identity and propagates policy rejection.',
  },
  {
    name: 'Tool after lifecycle',
    v1Hook: 'tool.execute.after',
    v2Mapping: "ctx.tool.hook('execute.after')",
    status: 'out-of-scope',
    reason: 'Completed/error result adaptation is implemented in a later work unit.',
  },
  {
    name: 'Custom workflow tools',
    v1Hook: 'hooks.tool',
    v2Mapping: 'ctx.tool.transform',
    status: 'deferred',
    reason: 'The V2 tool registration mapping is not part of V2.1/V2.2.',
  },
  {
    name: 'Session parent lookup',
    v1Hook: 'V1 client session API',
    v2Mapping: 'ctx.session',
    status: 'deferred',
    reason: 'The V2 session lookup adapter is not part of V2.1/V2.2.',
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
  },
];

export interface V2ToolRegistration {
  readonly registration: Registration;
  readonly dispose: () => Promise<void>;
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
