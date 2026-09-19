// ─── YAML Input Schemas ────────────────────────────────────────────────────────
//
// Zod schemas for validating YAML profile input. These mirror the runtime
// schemas but are designed for YAML parsing with strict key validation.
//
// Usage:
//   import { ProfileYamlSchema } from './yaml-schemas.ts';
//   const result = ProfileYamlSchema.safeParse(yamlContent);
//   if (!result.success) { /* handle ZodError */ }

import { z } from 'zod';

// ─── Reusable primitives ───────────────────────────────────────────────────────

const LoopSourceSchema = z
  .string()
  .min(1)
  .refine((source) => source !== 'task-17' && !/^task-\d+$/.test(source), {
    message: 'Loop source must not be a task instance key',
  })
  .refine((source) => source === '$currentTask.id' || !source.startsWith('$'), {
    message: 'Loop source must be a static list key or "$currentTask.id"',
  });

const ActionIdSchema = z.enum(['edit', 'bash']);

const ActionEntrySchema = z.object({
  action: ActionIdSchema,
  paths: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  delivers: z.boolean().optional(),
  guard: z.string().optional(),
});

const RetryBudgetSchema = z.object({
  maximum: z.number().int().min(1),
});

const TransitionEffectSchema = z.object({
  bumpRetry: z.string().optional(),
  maxAttempts: z.number().int().positive().optional(),
  approve: z.string().optional(),
});

const ConsentOnTransitionSchema = z.object({
  type: z.string(),
});

const TransitionDefSchema = z.object({
  from: z.string(),
  to: z.string(),
  guard: z.string().optional(),
  effects: z
    .array(
      z.object({
        bumpRetry: z.string().optional(),
        maxAttempts: z.number().int().positive().optional(),
        approve: z.string().optional(),
      })
    )
    .optional(),
  consent: z.union([z.string(), ConsentOnTransitionSchema]).optional(),
  onFailure: z.enum(['retry', 'terminal']).optional(),
});

const StageAssignmentRuleSchema = z.object({
  id: z.string(),
  priority: z.number(),
  condition: z.string(),
  result: z.string(),
});

const DispatchDefSchema = z.discriminatedUnion('strategy', [
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

// ─── Stage definition (recursive) ──────────────────────────────────────────────

const StageDefSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      loop: LoopSourceSchema.optional(),
      dispatch: DispatchDefSchema.optional(),
      retryBudget: RetryBudgetSchema.optional(),
      allowedAgents: z.array(z.string()).optional(),
      actions: z
        .array(
          z.object({
            action: ActionIdSchema,
            paths: z.array(z.string()).optional(),
            commands: z.array(z.string()).optional(),
            delivers: z.boolean().optional(),
            guard: z.string().optional(),
          })
        )
        .optional(),
      gates: z.array(z.string()).optional(),
      entryGuards: z.array(z.string()).optional(),
      exitGuards: z.array(z.string()).optional(),
      stages: z.record(StageDefSchema).optional(),
      transitions: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            guard: z.string().optional(),
            effects: z.array(TransitionEffectSchema).optional(),
            consent: z.union([z.string(), z.object({ type: z.string() })]).optional(),
            onFailure: z.enum(['retry', 'terminal']).optional(),
          })
        )
        .optional(),
    })
    .passthrough()
);

const ProfileSchemaSchema = z
  .object({
    extends: z.string().optional(),
    stages: z.record(StageDefSchema).optional(),
    stageAssignments: z.array(StageAssignmentRuleSchema).optional(),
    transitions: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          guard: z.string().optional(),
          effects: z.array(TransitionEffectSchema).optional(),
          consent: z.union([z.string(), z.object({ type: z.string() })]).optional(),
          onFailure: z.enum(['retry', 'terminal']).optional(),
        })
      )
      .optional(),
    editingAgents: z.array(z.string()).optional(),
    taskControlAgents: z.array(z.string()).optional(),
  })
  .strict() // Strict mode: reject unknown keys at profile level
  .superRefine((value, ctx) => {
    const seen = new Map<string, string>();
    for (const [stageId, stage] of Object.entries(
      ((value as Record<string, unknown>).stages as Record<string, { loop?: string }>) ?? {}
    )) {
      const stageObj = stage as { loop?: string };
      if (!stageObj.loop || stageObj.loop === '$currentTask.id') continue;
      const previousStage = seen.get(stageObj.loop);
      if (previousStage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', stageId, 'loop'],
          message: `Loop source '${stageObj.loop}' is already used by stage '${previousStage}'`,
        });
        return;
      }
      seen.set(stageObj.loop, stageId);
    }
  });

// ─── Type exports ──────────────────────────────────────────────────────────────

export type LoopSource = z.infer<typeof LoopSourceSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ActionEntry = z.infer<typeof ActionEntrySchema>;
export type ProfileRetryBudget = z.infer<typeof RetryBudgetSchema>;
export type TransitionEffect = z.infer<typeof TransitionEffectSchema>;
export type ConsentOnTransition = z.infer<typeof ConsentOnTransitionSchema>;
export type TransitionDef = z.infer<typeof TransitionDefSchema>;
export type StageAssignmentRule = z.infer<typeof StageAssignmentRuleSchema>;
export type DispatchDef = z.infer<typeof DispatchDefSchema>;
export type StageDef = z.infer<typeof StageDefSchema>;
export type ProfileSchema = z.infer<typeof ProfileSchemaSchema>;
export type ProfileYaml = z.input<typeof ProfileSchemaSchema>;

// ─── Schema exports ────────────────────────────────────────────────────────────

export const ProfileYamlSchema = ProfileSchemaSchema;
export const StageYamlSchema = StageDefSchema;
export const TransitionYamlSchema = TransitionDefSchema;
export const ActionEntryYamlSchema = ActionEntrySchema;
export const RetryBudgetYamlSchema = RetryBudgetSchema;
export const LoopSourceYamlSchema = LoopSourceSchema;
export const ActionIdYamlSchema = ActionIdSchema;
export const DispatchYamlSchema = DispatchDefSchema;
export const StageAssignmentRuleYamlSchema = StageAssignmentRuleSchema;
export const TransitionEffectYamlSchema = TransitionEffectSchema;
export const ConsentOnTransitionYamlSchema = ConsentOnTransitionSchema;
