import type {
  WorkflowSession,
  Gate,
  GateStatus,
  LoopRun,
  MutationTask,
  ActiveTaskContext,
  PendingDecision,
} from './session-schema.ts';

// ─── Gate helpers ─────────────────────────────────────────────────────────────

export function getGate(session: WorkflowSession, gateId: string): Gate | undefined {
  return session.gates.find((g) => g.id === gateId);
}

export interface SetGateStatusOptions {
  /** Retry budget key to bump when status is 'failed' */
  bumpRetry?: string;
}

export function setGateStatus(
  session: WorkflowSession,
  gateId: string,
  status: GateStatus,
  options?: SetGateStatusOptions
): void {
  const gate = session.gates.find((g) => g.id === gateId);
  if (!gate) return;
  gate.status = status;
  if (status === 'passed' || status === 'failed') {
    gate.resolvedAt = new Date().toISOString();
  } else {
    // При переводе в pending — очищаем устаревший resolvedAt
    gate.resolvedAt = undefined;
  }
  if (status === 'failed' && options?.bumpRetry) {
    bumpRetry(session, options.bumpRetry);
  }
}

// ─── Loop / task helpers ───────────────────────────────────────────────────────

const OPEN_LOOP_STATUSES = new Set(['pending', 'running', 'awaiting_decision']);

export function isOpenLoopRun(run: LoopRun): boolean {
  return OPEN_LOOP_STATUSES.has(run.status);
}

export function nextLoopRunId(session: WorkflowSession): string {
  let sequence = 1;
  while ((session.loopRuns ?? {})[`run-${sequence}`]) sequence += 1;
  return `run-${sequence}`;
}

export function findTask(session: WorkflowSession, taskId: string): MutationTask | undefined {
  return Object.values(session.tasks ?? {})
    .flat()
    .find((task) => task.id === taskId);
}

// ─── Retry budget helpers ─────────────────────────────────────────────────────

export function bumpRetry(session: WorkflowSession, budgetKey: string): void {
  if (!session.retryBudgets[budgetKey]) {
    session.retryBudgets[budgetKey] = { attempts: 0, maximum: 3 };
  }
  session.retryBudgets[budgetKey].attempts++;
}

export function isExhausted(session: WorkflowSession, budgetKey: string): boolean {
  const budget = session.retryBudgets[budgetKey];
  return budget ? budget.attempts >= budget.maximum : false;
}

export function resetRetry(session: WorkflowSession, budgetKey: string): void {
  session.retryBudgets[budgetKey] = { attempts: 0, maximum: 3 };
}

// ─── Active task context helpers ─────────────────────────────────────────────────

export function upsertActiveTaskContext(
  session: WorkflowSession,
  ctx: {
    runId: string;
    taskId: string;
    agent: string;
    executionSessionId?: string;
    callId?: string;
    status: ActiveTaskContext['status'];
  }
): void {
  const now = new Date().toISOString();
  const existing = session.activeTaskContexts.find((a) => a.runId === ctx.runId);
  if (existing) {
    existing.taskId = ctx.taskId;
    existing.agent = ctx.agent;
    if (ctx.executionSessionId !== undefined) existing.executionSessionId = ctx.executionSessionId;
    if (ctx.callId !== undefined) existing.callId = ctx.callId;
    existing.status = ctx.status;
    existing.updatedAt = now;
  } else {
    session.activeTaskContexts.push({
      runId: ctx.runId,
      taskId: ctx.taskId,
      agent: ctx.agent,
      executionSessionId: ctx.executionSessionId,
      callId: ctx.callId,
      status: ctx.status,
      startedAt: now,
      updatedAt: now,
    });
  }
}

export function removeActiveTaskContext(session: WorkflowSession, runId: string): void {
  session.activeTaskContexts = session.activeTaskContexts.filter((a) => a.runId !== runId);
}

/**
 * Resolve a pending retry context, optionally selecting by decisionId.
 *
 * If `decisionId` is provided, only that decision is considered and it must be
 * pending, of kind `retry_exhausted`, and its `runId`, context, run, task, and
 * retry budget must agree.
 *
 * If `decisionId` is omitted, exactly one unique valid pending retry context
 * must exist; ambiguity is rejected with candidate decision IDs.
 */
export function findPendingRetryContext(
  session: WorkflowSession,
  decisionId?: string
): { taskId: string; decision: PendingDecision; context: ActiveTaskContext; run: LoopRun } | null {
  const pendingDecisions = (session.pendingDecisions ?? []).filter(
    (d) => d.status === 'pending' && d.kind === 'retry_exhausted'
  );

  if (decisionId) {
    const decision = pendingDecisions.find((d) => d.id === decisionId);
    if (!decision) return null;

    // Resolve the run via decision.runId, falling back to the first run with matching subjectId
    const run = decision.runId
      ? Object.values(session.loopRuns).find((r) => r.id === decision.runId)
      : Object.values(session.loopRuns).find(
          (r) => r.taskId === decision.subjectId && r.status === 'awaiting_decision'
        );

    if (!run) return null;

    const context = session.activeTaskContexts.find(
      (a) =>
        a.runId === run.id && a.taskId === decision.subjectId && a.status === 'awaiting_decision'
    );
    if (!context) return null;

    return { taskId: decision.subjectId, decision, context, run };
  }

  // No selector — must be exactly one valid context
  const awaitingContexts = session.activeTaskContexts.filter(
    (a) => a.status === 'awaiting_decision'
  );
  if (awaitingContexts.length !== 1) return null;

  const context = awaitingContexts[0];
  const decisions = pendingDecisions.filter(
    (d) => d.subject === 'task' && d.subjectId === context.taskId
  );
  if (decisions.length !== 1) return null;

  const run = Object.values(session.loopRuns).find(
    (r) => r.id === context.runId && r.taskId === context.taskId && r.status === 'awaiting_decision'
  );
  if (!run) return null;

  return { taskId: context.taskId, context, decision: decisions[0], run };
}
