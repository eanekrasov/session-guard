/**
 * Shared test helpers — functions that exist only for test coverage
 * and are not used by production code.
 */
import type { WorkflowSession, WorkflowStore } from '../src/session/session-schema.ts';

// ─── Mutation lifecycle helpers ──────────────────────────────────────────────

export function hasLiveVerifier(session: WorkflowSession, _agent: string): boolean {
  return Object.values(session.activeOperations ?? {}).some((o) => o.status === 'running');
}

export function markOutputReady(id: string, session: WorkflowSession): void {
  const operation = session.activeOperations?.[id];
  if (!operation) return;
  operation.result = 'output_ready';
}

// ─── Session query helpers ───────────────────────────────────────────────────

export function getExecutionProgress(session: WorkflowSession): {
  completed: number;
  total: number;
  active: number;
} {
  const tasks = Object.values(session.tasks ?? {}).flat();
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const total = tasks.length;
  const active = Object.values(session.activeOperations ?? {}).filter(
    (o) => o.status === 'running'
  ).length;
  return { completed, total, active };
}

export function canExitExecution(session: WorkflowSession): boolean {
  if (Object.keys(session.activeOperations ?? {}).length > 0) return false;
  const tasks = Object.values(session.tasks ?? {}).flat();
  return tasks.every((t) => t.status === 'completed');
}

// ─── Session helpers ─────────────────────────────────────────────────────────

export function setInvariantViolations(
  session: WorkflowSession,
  violations: {
    severity: 'critical' | 'warning' | 'info';
    message: string;
    status: 'open' | 'resolved';
  }[]
): void {
  session.invariantViolations = violations.map((v, i) => ({
    ...v,
    evidenceId: `iv-${i + 1}`,
  }));
}

// ─── Verification helpers ─────────────────────────────────────────────────────

export function confirm(session: WorkflowSession, stage: string): void {
  const now = new Date().toISOString();
  const existing = session.verifications.find((v) => v.stage === stage);
  if (existing) {
    existing.status = 'confirmed';
    existing.recordedAt = now;
  } else {
    session.verifications.push({ stage, status: 'confirmed', recordedAt: now });
  }
}

export function rejectVerification(session: WorkflowSession, stage: string): void {
  const now = new Date().toISOString();
  const existing = session.verifications.find((v) => v.stage === stage);
  if (existing) {
    existing.status = 'rejected';
    existing.recordedAt = now;
  } else {
    session.verifications.push({ stage, status: 'rejected', recordedAt: now });
  }
}

// ─── Session queue helper ────────────────────────────────────────────────────

export async function withSession<T>(
  store: WorkflowStore,
  sessionID: string,
  action: (_session: WorkflowSession) => Promise<T> | T
): Promise<T | null> {
  const loaded = await store.load(sessionID);
  if (!loaded) return null;
  return action(loaded);
}
