import { setGateStatus, isOpenLoopRun, nextLoopRunId, findTask } from '../session/helpers.ts';
import type { WorkflowSession, ActiveOperation, LoopRun } from '../session/session-schema.ts';
import { MUTATION_TTL_MS } from './evidence.ts';

function getActiveOperations(session: WorkflowSession): ActiveOperation[] {
  return Object.values(session.activeOperations ?? {});
}

function getActiveOperation(session: WorkflowSession, callId?: string): ActiveOperation | null {
  if (callId) return session.activeOperations?.[callId] ?? null;

  const operations = getActiveOperations(session);
  return operations.length === 1 ? operations[0] : null;
}

function resolveMutationRun(session: WorkflowSession): LoopRun | null {
  session.loopRuns ??= {};
  session.activeOperations ??= {};
  const openRuns = Object.values(session.loopRuns).filter((run) => isOpenLoopRun(run));
  if (openRuns.length === 1) return openRuns[0];
  if (openRuns.length > 1) return null;

  const runnableTasks = Object.entries(session.tasks ?? {}).flatMap(([listKey, tasks]) =>
    tasks
      .filter((task) => task.status === 'pending' || task.status === 'running')
      .map((task) => ({ listKey, task }))
  );
  if (runnableTasks.length !== 1) return null;

  const [{ listKey, task }] = runnableTasks;
  const runId = nextLoopRunId(session);
  const run: LoopRun = {
    id: runId,
    taskId: task.id,
    listKey,
    ancestry: [],
    stage: 'mutation',
    status: 'running',
  };
  session.loopRuns[runId] = run;
  task.status = 'running';
  return run;
}

/**
 * Begin a new mutation. Throws when an active non-expired operation exists.
 *
 * Every verdict about the work is cleared: verifications, the session's
 * invariants gate, and the gates of the task being edited. A gate is evidence
 * about the code as it was, and an edit is exactly what makes that code no
 * longer the code. Editing twice inside one stage is ordinary — an architect
 * reworking a plan with the operator does it every time — so each edit must
 * start from no verdicts rather than inherit the last one's.
 */
export function beginMutation(
  session: WorkflowSession,
  callId: string,
  agent: string = 'unknown'
): void {
  for (const operation of getActiveOperations(session)) {
    if (isExpiredMutation(session, operation.callId)) {
      delete session.activeOperations[operation.callId];
    }
  }

  const existing = getActiveOperations(session)[0];
  if (existing) {
    throw new Error(`Active operation already exists: ${existing.callId}`);
  }

  const run = resolveMutationRun(session);
  if (!run) {
    throw new Error('Cannot resolve a single workflow task run for mutation');
  }

  session.activeOperations[callId] = {
    callId,
    runId: run.id,
    taskId: run.taskId,
    agent,
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  session.verifications = [];
  setGateStatus(session, 'invariants', 'pending');
  run.gates = {};
}

/**
 * Finish a mutation. Clears operation and updates invariants gate.
 * changedFiles is set by the caller (MutationOrchestrator) before calling
 * this function.
 */
export function finishMutation(session: WorkflowSession, passed: boolean, callId?: string): void {
  const operation = getActiveOperation(session, callId);
  if (operation) {
    delete session.activeOperations[operation.callId];
  }

  if (passed) {
    setGateStatus(session, 'invariants', 'passed');
    return;
  }

  setGateStatus(
    session,
    'invariants',
    'failed',
    operation ? { bumpRetry: operation.taskId } : undefined
  );
}

/** True when the active operation has been running longer than MUTATION_TTL_MS. */
export function isExpiredMutation(session: WorkflowSession, callId?: string): boolean {
  const operation = getActiveOperation(session, callId);
  if (!operation) return false;

  const startedAt = Date.parse(operation.startedAt);
  if (isNaN(startedAt)) return false;

  return Date.now() - startedAt >= MUTATION_TTL_MS;
}

/** Clear the active mutation. Safe no-op when already null. */
export function clearActiveMutation(session: WorkflowSession, callId?: string): void {
  const operation = getActiveOperation(session, callId);
  if (!operation) return;
  delete session.activeOperations[operation.callId];
}
