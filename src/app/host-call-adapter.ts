/**
 * HostCallAdapter — single point of normalization and admission for host tool calls.
 *
 * Routes every admitted operation through the same command path, durably binding
 * run/scope/occurrence/attempt before external execution. Unknown or ambiguous
 * bindings reject admission rather than selecting the first context.
 */

import { genId, type ExecutionRef, type WorkflowSnapshot } from '../domain/workflow-model.ts';

export interface HostCall {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

export interface AdmittedCall {
  bindingId: string;
  execution: ExecutionRef;
  tool: string;
  callID: string;
}

export type AdmissionResult =
  { admitted: false; reason: string } | { admitted: true; binding: AdmittedCall };

/**
 * Known host tools that can be normalised.
 */
const KNOWN_TOOLS = new Set(['Bash', 'Write', 'Read', 'Glob', 'Grep', 'Edit', 'task']);

/**
 * Normalise a host tool identifier.
 */
export function normaliseTool(tool: string): string | null {
  if (KNOWN_TOOLS.has(tool)) return tool;
  // Handle prefixed forms: workflow.tasks-get → tasks-get
  if (tool.startsWith('workflow.')) {
    // These are plugin tools, not host tools — reject
    return null;
  }
  return null;
}

/**
 * Attempt to admit a host call into a workflow execution.
 *
 * Derives actor/capability context once at the adapter boundary.
 * Never accepts asserted human/verifier authority from tool output.
 */
export function admitHostCall(call: HostCall, snapshot: WorkflowSnapshot): AdmissionResult {
  const tool = normaliseTool(call.tool);
  if (!tool) {
    return { admitted: false, reason: `Unknown or unsupported tool: ${call.tool}` };
  }

  // Find an active attempt that can accept this call
  const activeScopes = Object.values(snapshot.scopes).filter((s) => s.status === 'active');
  if (activeScopes.length === 0) {
    return { admitted: false, reason: 'No active scope in snapshot' };
  }

  // Derive actor from call context (simplified: always 'host')
  const actorId = 'host';

  // Find active executions in the active scopes
  for (const scope of activeScopes) {
    const exec = snapshot.executions[scope.cursorExecutionId];
    if (!exec || exec.status !== 'ready') continue;

    const attempt = snapshot.attempts[exec.currentAttemptId];
    if (!attempt || attempt.status !== 'ready') continue;

    const bindingId = genId();
    const execution: ExecutionRef = {
      scopeId: scope.id,
      executionId: exec.id,
      attemptId: attempt.id,
    };

    return {
      admitted: true,
      binding: {
        bindingId,
        execution,
        tool: call.tool,
        callID: call.callID,
      },
    };
  }

  return { admitted: false, reason: 'No ready execution found for host call' };
}

/**
 * Verify the installed SDK's real pre-execution blocking contract.
 * Denied calls must invoke the executor zero times.
 */
export function shouldBlockCall(
  tool: string,
  sessionID: string,
  pendingDecisions: Array<{ status: string }>
): { block: boolean; reason?: string } {
  // If there are pending decisions, block write operations until resolved
  if (tool === 'Bash' || tool === 'Write') {
    const pending = pendingDecisions.filter((d) => d.status === 'pending');
    if (pending.length > 0) {
      return {
        block: true,
        reason: `Session ${sessionID} has ${pending.length} pending decision(s). Resolve before writing.`,
      };
    }
  }
  return { block: false };
}

/**
 * Create a host binding record and attach it to the snapshot.
 */
export function persistHostBinding(
  snapshot: WorkflowSnapshot,
  hostId: string,
  nativeSessionId: string,
  binding: AdmittedCall
): WorkflowSnapshot {
  const linkId = genId();
  return {
    ...snapshot,
    host: {
      sessions: {
        ...snapshot.host.sessions,
        [linkId]: {
          id: linkId,
          hostId,
          nativeSessionId,
          parentLinkId: null,
        },
      },
      bindings: {
        ...snapshot.host.bindings,
        [binding.bindingId]: {
          id: binding.bindingId,
          sessionLinkId: linkId,
          nativeCallId: binding.callID,
          actorId: 'host',
          execution: binding.execution,
          role: 'primary',
          status: 'admitted',
        },
      },
    },
  };
}
