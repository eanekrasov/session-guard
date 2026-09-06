import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const ConsentOnTransitionSchema = z.object({
  type: z.string(),
});
export type ConsentOnTransition = z.infer<typeof ConsentOnTransitionSchema>;

const DispatchSchema = z.discriminatedUnion('strategy', [
  z.object({
    strategy: z.literal('serial'),
    maxConcurrent: z.undefined().optional(),
    overlapRoles: z.array(z.string()).optional(),
  }),
  z.object({
    strategy: z.literal('parallel'),
    maxConcurrent: z.number().int().positive(),
    overlapRoles: z.array(z.string()).optional(),
  }),
  z.object({
    strategy: z.literal('serial_with_overlap'),
    maxConcurrent: z.number().int().positive(),
    overlapRoles: z.array(z.string()).optional(),
  }),
]);

const LoopSourceSchema = z
  .string()
  .min(1)
  .refine((source) => source !== 'task-17' && !/^task-\d+$/.test(source), {
    message: 'Loop source must not be a task instance key',
  })
  .refine((source) => source === '$currentTask.id' || !source.startsWith('$'), {
    message: 'Loop source must be a static list key or "$currentTask.id"',
  });
export type LoopSource = z.infer<typeof LoopSourceSchema>;

const RetryBudgetSchema = z.object({
  maximum: z.number().int().min(1),
});
export type RetryBudget = z.infer<typeof RetryBudgetSchema>;

/**
 * A stage — the one unit of workflow state.
 *
 * A stage that names a `loop` runs its own `stages` once per task in that
 * list, moved by its own `transitions`. Nesting is the only difference between
 * an inner stage and an outer one: `allowedAgents`, `gates`, `transitions`,
 * guards, effects and retry budgets mean the same at either level, so a reader
 * learns one set of rules rather than two. See docs/stage-model.md.
 */
export interface StageDef {
  /** Task list this stage cycles over. Its `stages` then run once per task. */
  loop?: LoopSource;
  dispatch?: DispatchDef;
  retryBudget?: RetryBudget;
  /** Agents allowed to act while this stage is current. */
  allowedAgents?: string[];
  /**
   * Gates this stage closes.
   *
   * Declaring it makes the stage a verifier: its agent must finish with a
   * `<workflow-result>` tag whose `stage` equals this stage's id, `pass` sets
   * these gates to `passed` and `fail` sets them to `failed`. A gate named
   * here that no session carries is a schema load error, not runtime silence.
   */
  gates?: string[];
  entryGuards?: string[];
  exitGuards?: string[];
  /** Stages run per task, when this stage declares a `loop`. */
  stages?: Record<string, StageDef>;
  /** Transitions between this stage's own `stages`. */
  transitions?: TransitionDef[];
}

const StageDefSchema: z.ZodType<StageDef> = z.lazy(() =>
  z.object({
    loop: LoopSourceSchema.optional(),
    dispatch: DispatchSchema.optional(),
    retryBudget: RetryBudgetSchema.optional(),
    allowedAgents: z.array(z.string()).optional(),
    gates: z.array(z.string()).optional(),
    entryGuards: z.array(z.string()).optional(),
    exitGuards: z.array(z.string()).optional(),
    stages: z.record(StageDefSchema).optional(),
    transitions: z.array(TransitionDefSchema).optional(),
  })
);

const TransitionEffectSchema = z.object({
  bumpRetry: z.string().optional(),
  maxAttempts: z.number().int().positive().optional(),
  approve: z.string().optional(),
});
export type TransitionEffect = z.infer<typeof TransitionEffectSchema>;

const TransitionDefSchema = z.object({
  from: z.string(),
  to: z.string(),
  guard: z.string().optional(),
  kind: z.enum(['auto', 'pass', 'fail']).optional(),
  effects: z.array(TransitionEffectSchema).optional(),
  consent: z.union([z.string(), ConsentOnTransitionSchema]).optional(),
  onFailure: z.enum(['retry', 'terminal']).optional(),
});
export type TransitionDef = z.infer<typeof TransitionDefSchema>;

const StageAssignmentRuleSchema = z.object({
  id: z.string(),
  priority: z.number(),
  condition: z.string(),
  result: z.string(),
});
export type StageAssignmentRule = z.infer<typeof StageAssignmentRuleSchema>;

export const GateItemSchema = z.object({
  id: z.string(),
  status: z.string().default('pending'),
  label: z.string().optional(),
});
export type GateItem = z.infer<typeof GateItemSchema>;

export const ToolItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  run: z.string(),
  guard: z.string().optional(),
  silent: z.boolean().optional(),
});
export type ToolItem = z.infer<typeof ToolItemSchema>;

export type DispatchDef = z.infer<typeof DispatchSchema>;

export const ProfileSchemaSchema = z
  .object({
    extends: z.string().optional(),
    stages: z.record(StageDefSchema).optional(),
    stageAssignments: z.array(StageAssignmentRuleSchema).optional(),
    transitions: z.array(TransitionDefSchema).optional(),
    gates: z.array(GateItemSchema).optional(),
    tools: z.array(ToolItemSchema).optional(),
    gateMapping: z.record(z.array(z.string())).optional(),
    actionGuards: z.record(z.string()).optional(),
    editingAgents: z.array(z.string()).optional(),
    /**
     * Agents allowed to drive workflow task state (workflow.tasks-set,
     * workflow.tasks-set-status, workflow.tasks-resolve-decision).
     * Defaults to ['orchestrator'] — a worker must never close its own stage.
     */
    taskControlAgents: z.array(z.string()).optional(),
    verifiers: z.array(z.string()).optional(),
    requiredGates: z.array(z.string()).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const seen = new Map<string, string>();
    for (const [stageId, stage] of Object.entries(value.stages ?? {})) {
      if (!stage.loop || stage.loop === '$currentTask.id') continue;
      const previousStage = seen.get(stage.loop);
      if (previousStage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', stageId, 'loop'],
          message: `Loop source '${stage.loop}' is already used by stage '${previousStage}'`,
        });
        continue;
      }
      seen.set(stage.loop, stageId);
    }
  });

export type ProfileSchema = z.infer<typeof ProfileSchemaSchema>;

export const ProfileSchemaJsonSchema = zodToJsonSchema(ProfileSchemaSchema, {
  name: 'ProfileSchema',
  target: 'openApi3',
});
