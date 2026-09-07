import type {
  WorkflowSessionRead,
  GateStatus,
  TaskStatus,
  Verification,
  RetryBudget,
  ActiveOperation,
} from '../session/session-schema.ts';

// ─── SessionFacts interface ────────────────────────────────────────────────────

export interface SessionFacts {
  currentStage?: string;
  lastApproval: {
    type?: string;
    callId?: string;
    status?: 'pending' | 'granted' | 'denied';
    grantedAt?: string;
    evidence?: string;
    feedback?: string;
  } | null;
  approvals: Array<{ type: string; status: string }>; // for approved(type) guard expressions
  tasks: { id: string; status: TaskStatus }[];
  activeOperations: ActiveOperation[];
  /** Full verification records. Use `session.verified(stage, status)` in guard expressions. */
  verifications: Verification[];
  /** Guard-expression helper: `session.verified('bug', 'confirmed')` */
  verified(stage: string, status: 'confirmed' | 'rejected'): boolean;
  gates: Record<string, GateStatus>;
  profileId: string;
  /** Used in guard: `session.revision == 0` */
  revision: number;
  /** Used in guard: `session.deliveryReceipt exists`, `session.deliveryReceipt != null`.
   *  Always null until delivery model is implemented. */
  deliveryReceipt: string | null;
  deliveryPermit?: WorkflowSessionRead['deliveryPermit'];
  /** Document references (plan, spec, etc.) for guard expressions.
   *  Check with `session.refs.plan != null`. */
  refs: Record<string, string>;
  /** Retry budgets for guard expressions (e.g. `isExhausted('task-1')`). */
  retryBudgets: Record<string, RetryBudget>;
  /** Guard-expression helper: `isExhausted('task-1')` */
  isExhausted(budgetKey: string): boolean;
  /** Guard-expression helper: `session.approved(type)` — для consent-проверок в tryApplyTransitions. */
  approved(type: string): boolean;
}

// ─── Projection function ───────────────────────────────────────────────────────

export function toSessionFacts(session: WorkflowSessionRead): SessionFacts {
  const tasks = session.tasks ?? {};
  const activeOperations = session.activeOperations ?? {};
  const retryBudgets = session.retryBudgets ?? {};

  return {
    currentStage: session.currentStage,
    lastApproval:
      session.approvals.length > 0
        ? (session.approvals[session.approvals.length - 1] ?? null)
        : null,
    approvals: session.approvals.map((a) => ({ type: a.type, status: a.status })),
    // Existing guards consume a flat task view while sessions retain list ownership.
    tasks: Object.values(tasks)
      .flat()
      .map((task) => ({ id: task.id, status: task.status })),
    activeOperations: Object.values(activeOperations),
    verifications: session.verifications.map((v) => ({ stage: v.stage, status: v.status })),
    verified(stage: string, status: 'confirmed' | 'rejected') {
      return this.verifications.some((v) => v.stage === stage && v.status === status);
    },
    gates: Object.fromEntries(session.gates.map((g) => [g.id, g.status])),
    profileId: session.profileId,
    revision: session.revision,
    deliveryReceipt: session.deliveryReceipt ?? null,
    deliveryPermit: session.deliveryPermit ?? null,
    refs: { ...session.refs },
    retryBudgets,
    isExhausted(budgetKey: string) {
      const budget = this.retryBudgets[budgetKey];
      return budget ? budget.attempts >= budget.maximum : false;
    },
    approved(type: string) {
      return this.approvals.some((a) => a.type === type && a.status === 'granted');
    },
  };
}
