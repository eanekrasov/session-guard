import { z } from 'zod';

// ─── Enum constants (as const for Zod enums) ──────────────────────────────────

export const GATE_STATUS = ['pending', 'running', 'passed', 'failed', 'skipped'] as const;
export const TASK_STATUS = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export const LOOP_RUN_STATUS = [
  'pending',
  'running',
  'awaiting_decision',
  'completed',
  'failed',
  'cancelled',
] as const;

// ─── Nested schemas ───────────────────────────────────────────────────────────

export const ApprovalSchema = z.object({
  type: z.string().min(1, 'Approval type is required'),
  callId: z.string().min(1, 'Approval callId is required'),
  status: z.enum(['pending', 'granted', 'denied']),
  grantedAt: z.string().optional(),
  evidence: z.string().optional(),
  feedback: z.string().optional(),
});

export const GateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(GATE_STATUS),
  label: z.string().optional(),
  resolvedAt: z.string().optional(),
});

export const ActiveOperationSchema = z.object({
  callId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().regex(/^task-[0-9]+$/, 'Workflow task id must match task-[0-9]+'),
  agent: z.string().min(1),
  status: z.enum(['running', 'interrupted']),
  startedAt: z.string().min(1),
  interruptedAt: z.string().optional(),
  result: z.enum(['output_ready']).optional(),
  /**
   * Which occupancy of the stage this call belongs to.
   *
   * Two verifiers work one stage at once. When the first verdict moves the
   * task, the second is still in flight — and it is a verdict about work the
   * task has already left. Stamping the round is what lets a late result be
   * recognised as belonging to a round that is over.
   */
  round: z.number().int().min(0).default(0),
  /**
   * The pre-move snapshot of the dirty working tree (`captureBaseline`),
   * stored only for `bash`, `apply_patch` and `task` — moves whose target
   * files are not fully known from arguments alone (see design.md D1/D2).
   * `write`/`edit` name their target in arguments and carry no frame.
   */
  baseline: z.record(z.string().nullable()).optional(),
  /** This move's invariants verdict, rolled into `run.gates.invariants` when the operation ends. */
  invariants: z.enum(GATE_STATUS).optional(),
});

export const RetryBudgetSchema = z.object({
  attempts: z.number().int().min(0),
  maximum: z.number().int().min(1),
});

export const PendingDecisionSchema = z.object({
  id: z.string().min(1),
  subject: z.enum(['task']),
  subjectId: z.string().min(1),
  runId: z.string().optional(),
  kind: z.string().min(1),
  status: z.enum(['pending', 'resolved']),
  createdAt: z.string().min(1),
  resolvedAt: z.string().optional(),
  resolution: z.string().optional(),
});

export const MutationTaskSchema = z.object({
  id: z.string().regex(/^task-[0-9]+$/, 'Workflow task id must match task-[0-9]+'),
  status: z.enum(TASK_STATUS),
  title: z.string().optional(),
  branch: z.string().optional(),
  testResult: z.enum(['pass', 'fail', 'unknown']).optional(),
  /**
   * Which files this task may read, as glob masks matched by
   * `matchesScope` (`app/scope-match.ts`). `readScope` is focus — which
   * files are relevant to the task — not a confidentiality boundary.
   * Absent means "no read restriction" for gates that check it.
   */
  readScope: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^(?!!)/, 'Scope masks do not support negation (!...)')
    )
    .optional(),
  /**
   * Which files this task may write, as glob masks. Absent or empty means
   * read-only: every write is refused, and the task overlaps nothing for
   * parallel admission (`scopesIntersect`). Independent of `readScope` —
   * neither is derived from the other.
   */
  writeScope: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^(?!!)/, 'Scope masks do not support negation (!...)')
    )
    .optional(),
  /** Agents allowed to issue this task's mutating tool calls. */
  editingAgents: z.array(z.string()).optional(),
});

export const LoopRunSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().regex(/^task-[0-9]+$/, 'Workflow task id must match task-[0-9]+'),
  listKey: z.string().min(1),
  ancestry: z.array(
    z.object({
      listKey: z.string().min(1),
      taskId: z.string().regex(/^task-[0-9]+$/, 'Workflow task id must match task-[0-9]+'),
    })
  ),
  stage: z.string().min(1),
  status: z.enum(LOOP_RUN_STATUS),
  /**
   * Gates closed for this task, by gate id.
   *
   * A gate is evidence about the work it was produced for. Inside a loop the
   * work is one task, so its gates live on its run: with a parallel dispatch a
   * session-wide gate would let the first task to pass review close the stage
   * on behalf of every other task.
   */
  gates: z.record(z.enum(GATE_STATUS)).default({}),
  /** Increments every time the task enters a stage. See ActiveOperation.round. */
  round: z.number().int().min(0).default(0),
});

const TasksSchema = z.record(z.array(MutationTaskSchema)).superRefine((taskLists, context) => {
  const taskIds = new Set<string>();
  for (const [listKey, tasks] of Object.entries(taskLists)) {
    for (const task of tasks) {
      if (taskIds.has(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow task id must be unique across task lists: ${task.id}`,
          path: [listKey],
        });
      }
      taskIds.add(task.id);
    }
  }
});

const ActiveOperationsSchema = z
  .record(ActiveOperationSchema)
  .superRefine((operations, context) => {
    for (const [callId, operation] of Object.entries(operations)) {
      if (callId !== operation.callId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Active operation key must match native call id: ${callId}`,
          path: [callId],
        });
      }
    }
  });

const LoopRunsSchema = z.record(LoopRunSchema).superRefine((loopRuns, context) => {
  for (const [runId, loopRun] of Object.entries(loopRuns)) {
    if (runId !== loopRun.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Loop run key must match generated run id: ${runId}`,
        path: [runId],
      });
    }
  }
});

const RetryBudgetsSchema = z.record(RetryBudgetSchema).superRefine((retryBudgets, context) => {
  for (const taskId of Object.keys(retryBudgets)) {
    if (!/^task-[0-9]+$/.test(taskId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Retry budget key must be a workflow task id: ${taskId}`,
        path: [taskId],
      });
    }
  }
});

export const ActiveTaskContextSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().regex(/^task-[0-9]+$/, 'Workflow task id must match task-[0-9]+'),
  agent: z.string().min(1),
  executionSessionId: z.string().optional(),
  callId: z.string().optional(),
  status: z.enum(['running', 'awaiting_decision']),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const InvariantViolationRecordSchema = z.object({
  evidenceId: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']),
  message: z.string().min(1),
  status: z.enum(['open', 'resolved']),
});

export const DeliveryPermitSchema = z.object({
  callID: z.string().min(1),
  preCommitHead: z.string().min(1),
  expectedFiles: z.array(z.string()).default([]),
  startedAt: z.string().min(1),
});

export const VerificationSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(['confirmed', 'rejected']),
  recordedAt: z.string().optional(),
});

// ─── WorkflowSession schema (strip mode — for save) ───────────────────────────

export const WorkflowSessionSchema = z
  .object({
    sessionId: z.string().min(1, 'sessionId is required'),
    profileId: z.string().min(1, 'profileId is required'),
    // A profile may hold several independent schemas; the session runs exactly
    // one of them, named here by its id within the profile.
    schemaId: z.string().min(1, 'schemaId is required'),
    schemaVersion: z.number().int().positive().default(2),
    revision: z.number().int().min(0).default(0),
    title: z.string().default(''),
    gates: z.array(GateSchema).default([]),
    approvals: z.array(ApprovalSchema).default([]),
    refs: z.record(z.string()).default({}),
    tasks: TasksSchema.default({}),
    activeOperations: ActiveOperationsSchema.default({}),
    activeTaskContexts: z.array(ActiveTaskContextSchema).default([]),
    loopRuns: LoopRunsSchema.default({}),
    testStatus: z.record(z.string()).default({}),
    deliveryPermit: DeliveryPermitSchema.nullable().default(null),
    deliveryReceipt: z.string().nullable().default(null),
    retryBudgets: RetryBudgetsSchema.default({}),
    pendingDecisions: z.array(PendingDecisionSchema).default([]),
    updatedAt: z.string().default(() => new Date().toISOString()),
    verifications: z.array(VerificationSchema).default([]),
    changedFiles: z.array(z.string()).default([]),
    currentStage: z.string().default('planning'),
    invariantViolations: z.array(InvariantViolationRecordSchema).default([]),
    consentedCallIDs: z.array(z.string()).default([]),
  })
  .strip();

// ─── Derived types (replaces src/session/types.ts) ────────────────────────────

export type GateStatus = (typeof GATE_STATUS)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];
export type LoopRunStatus = (typeof LOOP_RUN_STATUS)[number];
export type ApprovalStatus = z.output<typeof ApprovalSchema>['status'];
export type Severity = z.output<typeof InvariantViolationRecordSchema>['severity'];
export type ViolationStatus = z.output<typeof InvariantViolationRecordSchema>['status'];

export type Gate = z.output<typeof GateSchema>;
export type Approval = z.output<typeof ApprovalSchema>;
export type ActiveOperation = z.output<typeof ActiveOperationSchema>;
export type ActiveTaskContext = z.output<typeof ActiveTaskContextSchema>;
export type RetryBudget = z.output<typeof RetryBudgetSchema>;
export type PendingDecision = z.output<typeof PendingDecisionSchema>;
export type MutationTask = z.output<typeof MutationTaskSchema>;
export type LoopRun = z.output<typeof LoopRunSchema>;
export type Verification = z.output<typeof VerificationSchema>;
export type ValidationRecord = z.output<typeof InvariantViolationRecordSchema>;
export type DeliveryPermit = z.output<typeof DeliveryPermitSchema>;

// ─── WorkflowSession type (derived from schema — single source of truth) ──────

export type WorkflowSession = z.output<typeof WorkflowSessionSchema>;
export type WorkflowSessionRead = z.input<typeof WorkflowSessionSchema>;

// ─── Well-known reference keys ─────────────────────────────────────────────────

/** Key for the plan document reference in `refs`. */
export const REF_PLAN = 'plan';
