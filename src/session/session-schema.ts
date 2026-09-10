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
  /**
   * Every file the consent manifest named, in manifest order.
   *
   * A manifest may name several documents; only the first was hashed, so a
   * second one edited between the question and the answer went unnoticed and
   * the consent was accepted. The evidence now covers all of them, and this is
   * the list the decision-time re-read walks.
   */
  files: z.array(z.string()).optional(),
});

export const StageGateResultSchema = z.object({
  stage: z.string().min(1),
  id: z.string().min(1),
  status: z.enum(GATE_STATUS),
  resolvedAt: z.string().optional(),
});

export const ActiveOperationSchema = z.object({
  callId: z.string().min(1),
  /**
   * Прогон задачи, которому принадлежит ход, — когда он есть.
   *
   * Ход бывает и вне цикла: стадия без `loop:` — это обычная стадия, на
   * которой тоже работают. Раньше `beginMutation` в таком случае бросал
   * «Cannot resolve a single workflow task run for mutation», и любая правка
   * на плоской стадии была невозможна в принципе — агент получал внутреннюю
   * ошибку, а не отказ. Отсутствие прогона теперь описывает себя само.
   */
  runId: z.string().min(1).optional(),
  taskId: z
    .string()
    .regex(/^task-[0-9]+$/, 'Workflow task id must match task-[0-9]+')
    .optional(),
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
  /**
   * Вердикт ядра об этом ходе: прошли ли проверки над ним.
   *
   * Сворачивается в `run.checks`, когда ход закрывается. Не гейт намеренно:
   * гейт пишет агент через `<workflow-result>`, и любой гейт, объявленный
   * стадией, он может выставить сам. Этот вердикт движок выносит, посмотрев
   * на диск, и его ценность как раз в независимости от того, что агент про
   * себя рассказал.
   */
  checks: z.enum(GATE_STATUS).optional(),
  /**
   * What kind of call this operation belongs to.
   *
   * A dispatched `task` and a mutating `bash`/`write` are both operations, but
   * only the mutation is tracked in the orchestrator's in-flight map. Lock
   * release read "absent from that map" as "interrupted", which is true of a
   * dead mutation and always true of a live task call — so an ordinary write
   * inside a running task's writeScope deleted the task's own operation and
   * took its place.
   */
  kind: z.enum(['mutation', 'task']).default('mutation'),
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

/**
 * Чем и почему кончился workflow.
 *
 * Пишется один раз, при входе в терминальную стадию. До этого «дошли до
 * конца», «упёрлись в исчерпанный бюджет» и «провалили проверку» выглядели в
 * файле сессии одинаково: стадия `done` или `failed` и больше ничего. Читатель
 * архива видел ИСХОД и не видел ПРИЧИНЫ.
 *
 * Причину называет сама схема: `guard` — это условие ребра, по которому
 * workflow ушёл в конец, слово в слово как его написал автор профиля. Ядру не
 * приходится выдумывать классификацию поверх чужих правил, а `failedGates` и
 * `exhaustedBudgets` показывают, что было верно в тот момент.
 */
export const WorkflowOutcomeSchema = z.object({
  /** Терминальная стадия, в которую пришли. */
  stage: z.string().min(1),
  /** Откуда пришли. */
  from: z.string().min(1),
  /** Условие ребра — причина словами схемы. `null`, когда ребро без guard-а. */
  guard: z.string().nullable(),
  /** Гейты сессии, провалившиеся к этому моменту. */
  failedGates: z.array(z.string()).default([]),
  /** Бюджеты повторов, израсходованные к этому моменту. */
  exhaustedBudgets: z.array(z.string()).default([]),
  recordedAt: z.string().min(1),
});
export type WorkflowOutcome = z.infer<typeof WorkflowOutcomeSchema>;

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
  /**
   * Вердикт последнего хода этой задачи — результат проверок ядра над ним.
   *
   * Складывает четыре причины отказа: упавший инструмент, запись вне
   * `writeScope`, несчитанный дифф и нарушенные инварианты профиля. Поэтому
   * `checks`, а не `invariants`: инварианты — лишь одна из четырёх.
   *
   * Читается guard-ами как `task.checks`.
   */
  checks: z.enum(GATE_STATUS).optional(),
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

/**
 * A budget key is either a workflow task id or a workflow-level budget name.
 *
 * There are two budgets, not one. Inside a loop the budget belongs to the task
 * and is written `task.id`, which resolves to `task-N`. At workflow level it
 * belongs to the session — `base.yaml` spends `cycles` when validation sends
 * the whole body of work back into the loop. This used to accept only
 * `task-N`, so the shipped profile's own validation-failure edge could not be
 * saved: the session stayed in `validation` with an empty budget and no
 * repetition helped.
 */
const BUDGET_KEY = /^(?:task-[0-9]+|[a-z][a-z0-9_-]*)$/;

const RetryBudgetsSchema = z.record(RetryBudgetSchema).superRefine((retryBudgets, context) => {
  for (const budgetKey of Object.keys(retryBudgets)) {
    if (!BUDGET_KEY.test(budgetKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Retry budget key must be a workflow task id or a workflow-level budget name: ${budgetKey}`,
        path: [budgetKey],
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
    stageGateResults: z.array(StageGateResultSchema).default([]),
    approvals: z.array(ApprovalSchema).default([]),
    refs: z.record(z.string()).default({}),
    tasks: TasksSchema.default({}),
    activeOperations: ActiveOperationsSchema.default({}),
    activeTaskContexts: z.array(ActiveTaskContextSchema).default([]),
    loopRuns: LoopRunsSchema.default({}),
    deliveryPermit: DeliveryPermitSchema.nullable().default(null),
    deliveryReceipt: z.string().nullable().default(null),
    retryBudgets: RetryBudgetsSchema.default({}),
    pendingDecisions: z.array(PendingDecisionSchema).default([]),
    updatedAt: z.string().default(() => new Date().toISOString()),
    verifications: z.array(VerificationSchema).default([]),
    changedFiles: z.array(z.string()).default([]),
    currentStage: z.string().default('planning'),
    /**
     * Вердикт ядра о последнем ходе на текущей стадии — вне цикла задач.
     *
     * Ровно то же, что `run.checks` внутри цикла, и по той же причине не
     * гейт: гейты пишет агент через `<workflow-result>` и любой объявленный
     * стадией гейт может выставить себе сам, а этот вердикт ядро выносит,
     * посмотрев на диск. Внутри цикла ему есть куда лечь — на прогон задачи;
     * снаружи домом стала сессия.
     *
     * Живёт ровно одну стадию: при переходе сбрасывается, потому что вердикт
     * о ходе на `checkout` ничего не говорит о работе на `build`. Читается
     * guard-ами как `session.checks`.
     */
    checks: z.enum(GATE_STATUS).optional(),
    /** Чем кончился workflow — см. `WorkflowOutcomeSchema`. */
    outcome: WorkflowOutcomeSchema.optional(),
    invariantViolations: z.array(InvariantViolationRecordSchema).default([]),
    consentedCallIDs: z.array(z.string()).default([]),
    /**
     * Call ids whose `<workflow-result>` has already been acted on.
     *
     * The result handler deletes the operation once it has recorded the
     * verdict, so a second delivery of the same call found no operation and
     * fell into the session-level branch: two task verdicts, replayed, closed
     * the session's own review and qa gates and carried the workflow past
     * validation without anyone having validated anything.
     */
    processedResultCallIDs: z.array(z.string()).default([]),
  })
  .strip();

// ─── Derived types (replaces src/session/types.ts) ────────────────────────────

export type GateStatus = (typeof GATE_STATUS)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];
export type LoopRunStatus = (typeof LOOP_RUN_STATUS)[number];
export type ApprovalStatus = z.output<typeof ApprovalSchema>['status'];
export type Severity = z.output<typeof InvariantViolationRecordSchema>['severity'];
export type ViolationStatus = z.output<typeof InvariantViolationRecordSchema>['status'];

export type StageGateResult = z.output<typeof StageGateResultSchema>;
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
