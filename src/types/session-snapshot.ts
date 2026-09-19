// ─── SessionSnapshot ──────────────────────────────────────────────────────────
//
// Typed, serializable snapshot of a WorkflowSession for UI/dashboard/TUI.
// Excludes internal/legacy fields (baselineHashes, changedFiles, etc.).
//
// Usage:
//   import { toSessionSnapshot } from 'session-guard/domain/session-snapshot';
//   const snapshot = toSessionSnapshot(session);
//   // snapshot is safe to JSON.stringify and pass to UI

import type {
  WorkflowSession,
  GateStatus,
  TaskStatus,
  ActiveOperation,
  WorkflowOutcome,
  RetryBudget,
} from '../session/session-schema.ts';

export interface SessionSnapshot {
  /** Unique session identifier */
  sessionId: string;
  /** Profile identifier (e.g. "android", "go", "rust") */
  profileId: string;
  /** Current stage name (e.g. "planning", "execution", "review") */
  currentStage?: string;
  /** Monotonically increasing revision counter */
  revision: number;
  /** Session title (optional) */
  title?: string;

  /** All tasks flattened with minimal fields for display */
  tasks: Array<{
    id: string;
    status: TaskStatus;
    title?: string;
    branch?: string;
  }>;
  /** Active operations (running tool calls, mutations), keyed by callId */
  activeOperations: Record<string, ActiveOperation>;
  /** Gate statuses keyed by gate ID */
  gates: Record<string, GateStatus>;
  /** Approval records */
  approvals: Array<{ type: string; status: string }>;
  /** Verification/verdict records */
  verifications: Array<{ gate: string; status: string }>;
  /** Schema ID the session was created from */
  schemaId: string;
  /** Schema version */
  schemaVersion: number;
  /** Delivery receipt (null until delivery model implemented) */
  deliveryReceipt: string | null;
  /** Document references (plan, spec, etc.) */
  refs: Record<string, string>;
  /** Core guard status outside loops */
  checks?: GateStatus;

  /** Updated at timestamp (ISO string) */
  updatedAt?: string;

  /** Invariant violation records */
  invariantViolations?: Array<Record<string, unknown>>;

  /** Final workflow outcome */
  outcome?: WorkflowOutcome;

  /** Retry budgets keyed by budget name */
  retryBudgets?: Record<string, RetryBudget>;

  /** Pending decisions awaiting resolution */
  pendingDecisions?: Array<Record<string, unknown>>;

  /** Explicitly excluded — no raw session data in snapshot */
  raw?: never;

  /** Allow dynamic access for UI code that iterates keys */
  [key: string]: unknown;
}

/**
 * Convert a WorkflowSession into a SessionSnapshot.
 * Strips internal/legacy fields, flattens tasks, keeps only UI-relevant data.
 */
export function toSessionSnapshot(session: WorkflowSession): SessionSnapshot {
  const tasks = session.tasks ?? {};

  return {
    sessionId: session.sessionId,
    profileId: session.profileId,
    currentStage: session.currentStage,
    revision: session.revision,
    updatedAt: session.updatedAt,
    title: session.title,
    tasks: Object.values(tasks)
      .flat()
      .map((task) => ({
        id: task.id,
        status: task.status,
        title: task.title,
        branch: task.branch,
      })),
    activeOperations: session.activeOperations ?? {},
    gates: Object.fromEntries(session.stageGateResults.map((g) => [g.id, g.status])),
    approvals: session.approvals.map((a) => ({ type: a.type, status: a.status })),
    verifications: session.verifications.map((v) => ({ gate: v.gate, status: v.status })),
    schemaId: session.schemaId,
    schemaVersion: session.schemaVersion,
    deliveryReceipt: session.deliveryReceipt ?? null,
    refs: { ...session.refs },
    checks: session.checks,
    invariantViolations: session.invariantViolations,
    outcome: session.outcome,
    retryBudgets: session.retryBudgets,
    pendingDecisions: session.pendingDecisions,
  };
}
