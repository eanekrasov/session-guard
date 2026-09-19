import type {
  WorkflowSession,
  GateStatus,
  TaskStatus,
  Verification,
  RetryBudget,
  ActiveOperation,
} from '../session/session-schema.ts';

// ─── BaseSessionFacts — common shape for both interfaces ────────────────────────

interface BaseSessionFacts {
  /** Current stage name (e.g. "planning", "validation") */
  currentStage?: string;

  /** Last approval record, or null if none */
  lastApproval: {
    type?: string;
    callId?: string;
    status?: 'pending' | 'granted' | 'denied';
    grantedAt?: string;
    evidence?: string;
    feedback?: string;
  } | null;

  /** Approval records for guard expressions like `session.approved('plan')` */
  approvals: ReadonlyArray<{ type: string; status: string }>;

  /** Task records — flat array {id, status} (always array from toSessionFacts) */
  tasks: ReadonlyArray<{ id: string; status: TaskStatus }>;

  /** Active operations — flat array from session.activeOperations */
  activeOperations: ReadonlyArray<ActiveOperation>;

  /** Verification records */
  verifications: ReadonlyArray<Verification>;

  /** Gates map — Record<string, GateStatus> */
  gates: Record<string, GateStatus>;

  /** Profile ID string */
  profileId: string;

  /** Session revision number */
  revision: number;

  /** Delivery receipt, null until delivery model implemented */
  deliveryReceipt: string | null;

  /** Delivery permit from consent model */
  deliveryPermit?: WorkflowSession['deliveryPermit'];

  /** Document references (plan, spec, etc.) */
  refs: Record<string, string>;

  /** Retry budgets — keyed by task ID or budget name */
  retryBudgets: Record<string, { attempts: number; maximum: number }>;

  /** Core guard status outside loops */
  checks?: GateStatus;

  /** Allow extra properties for GuardEvaluator compatibility */
  [key: string]: unknown;
}

// ─── GuardEvaluationSession — permissive for test mocks and partial data ────────

/**
 * Data-only subset for GuardEvaluator constructor.
 *
 * All properties optional to accept:
 * 1. Test mock objects with varying shapes
 * 2. Partial data from other sources
 *
 * GuardEvaluator internally casts to Record<string, unknown> and reads
 * only the properties it needs — so missing/extra properties are harmless.
 *
 * Note: Some properties accept union types (array | Record) to accommodate
 * different mock shapes used in tests.
 */
export interface GuardEvaluationSession {
  currentStage?: string;
  lastApproval?: BaseSessionFacts['lastApproval'];
  approvals?: BaseSessionFacts['approvals'];
  tasks?:
    | ReadonlyArray<{ id: string; status: TaskStatus }>
    | Record<string, ReadonlyArray<{ id: string; status: TaskStatus }>>
    // Test mock shapes: { implementation: {...}, release: {...} } or { id: string }[]
    | Record<string, ReadonlyArray<{ id: string; status?: string }>>
    | ReadonlyArray<{ id: string; status?: string }>;
  activeOperations?:
    ReadonlyArray<ActiveOperation> | Record<string, ActiveOperation> | Record<string, unknown>;
  verifications?: BaseSessionFacts['verifications'];
  gates?:
    | Record<string, GateStatus>
    | ReadonlyArray<{ id: string; status: GateStatus }>
    // Test mock shapes: array with string status
    | Record<string, string>
    | ReadonlyArray<{ id: string; status: string }>;
  profileId?: string;
  revision?: number;
  deliveryReceipt?: string | null;
  deliveryPermit?: WorkflowSession['deliveryPermit'];
  refs?: Record<string, string>;
  retryBudgets?: Record<string, { attempts: number; maximum: number }>;
  checks?: GateStatus;
  [key: string]: unknown;
}

// ─── SessionFacts interface ──────────────────────────────────────────────────────

/**
 * The full session facts interface used for guard expressions and UI display.
 * Always fully populated by toSessionFacts().
 *
 * Methods:
 *   - `verified(gate, status)` — check if a verdict was granted for a gate
 *   - `isExhausted(budgetKey)` — check if a retry budget is exhausted
 *   - `approved(type)` — check if an approval of given type was granted
 */
export interface SessionFacts extends BaseSessionFacts {
  /** Guard-expression helper: `session.verified('bug', 'confirmed')` */
  verified(gate: string, status: 'confirmed' | 'rejected'): boolean;
  /** Guard-expression helper: `isExhausted('task-1')` */
  isExhausted(budgetKey: string): boolean;
  /** Guard-expression helper: `session.approved(type)` — для consent-проверок */
  approved(type: string): boolean;
}

// ─── Projection function ───────────────────────────────────────────────────────

/**
 * Project a WorkflowSession into SessionFacts — a flat data structure without
 * session-internal tracking (task ownership, loop state, etc.).
 *
 * The result is a plain data object suitable for guard evaluation and UI display.
 * Methods (`verified`, `isExhausted`, `approved`) are bound to the data so they
 * can be called directly on the returned object.
 */
export function toSessionFacts(session: WorkflowSession): SessionFacts {
  const tasks = session.tasks ?? {};
  const activeOperations = session.activeOperations ?? {};
  const retryBudgets = session.retryBudgets ?? {};

  const facts: BaseSessionFacts = {
    currentStage: session.currentStage,
    lastApproval:
      session.approvals.length > 0
        ? (session.approvals[session.approvals.length - 1] ?? null)
        : null,
    approvals: session.approvals.map((a) => ({ type: a.type, status: a.status })),
    tasks: Object.values(tasks)
      .flat()
      .map((task) => ({ id: task.id, status: task.status })),
    activeOperations: Object.values(activeOperations),
    verifications: session.verifications.map((v) => ({ gate: v.gate, status: v.status })),
    gates: Object.fromEntries(session.stageGateResults.map((g) => [g.id, g.status])),
    profileId: session.profileId,
    revision: session.revision,
    deliveryReceipt: session.deliveryReceipt ?? null,
    deliveryPermit: session.deliveryPermit ?? null,
    refs: { ...session.refs },
    retryBudgets,
    checks: session.checks,
  };

  return {
    ...facts,
    verified(gate: string, status: 'confirmed' | 'rejected') {
      return facts.verifications.some((v) => v.gate === gate && v.status === status);
    },
    isExhausted(budgetKey: string) {
      const budget = facts.retryBudgets[budgetKey];
      return budget ? budget.attempts >= budget.maximum : false;
    },
    approved(type: string) {
      return facts.approvals.some((a) => a.type === type && a.status === 'granted');
    },
  };
}
