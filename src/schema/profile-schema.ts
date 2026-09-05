import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const ConsentOnTransitionSchema = z.object({
  type: z.string(),
});

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

const RetryBudgetSchema = z.object({
  maximum: z.number().int().min(1),
});

const StageDefSchema = z.object({
  id: z.string(),
  allowedAgents: z.array(z.string()).optional(),
  entryGuards: z.array(z.string()).optional(),
  exitGuards: z.array(z.string()).optional(),
});

const PhaseDefSchema = z.object({
  loop: LoopSourceSchema.optional(),
  dispatch: DispatchSchema.optional(),
  retryBudget: RetryBudgetSchema.optional(),
  stages: z.array(StageDefSchema).optional(),
  exitGuards: z.array(z.string()).optional(),
  allowedAgents: z.array(z.string()).optional(),
});

const TransitionEffectSchema = z.object({
  bumpRetry: z.string().optional(),
  maxAttempts: z.number().int().positive().optional(),
  approve: z.string().optional(),
});

const TransitionDefSchema = z.object({
  from: z.string(),
  to: z.string(),
  guard: z.string().optional(),
  kind: z.enum(['auto', 'pass', 'fail']).optional(),
  effects: z.array(TransitionEffectSchema).optional(),
  consent: z.union([z.string(), ConsentOnTransitionSchema]).optional(),
  onFailure: z.enum(['retry', 'terminal']).optional(),
});

const PhaseAssignmentRuleSchema = z.object({
  id: z.string(),
  priority: z.number(),
  condition: z.string(),
  result: z.string(),
});

export const ProfileSchemaSchema = z
  .object({
    extends: z.string().optional(),
    phases: z.record(PhaseDefSchema).optional(),
    phaseAssignments: z.array(PhaseAssignmentRuleSchema).optional(),
    transitions: z.array(TransitionDefSchema).optional(),
    gates: z
      .array(
        z.object({
          id: z.string(),
          status: z.string().default('pending'),
          label: z.string().optional(),
        })
      )
      .optional(),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          run: z.string(),
          guard: z.string().optional(),
          silent: z.boolean().optional(),
        })
      )
      .optional(),
    gateMapping: z.record(z.array(z.string())).optional(),
    actionGuards: z.record(z.string()).optional(),
    editingAgents: z.array(z.string()).optional(),
    verifiers: z.array(z.string()).optional(),
    requiredGates: z.array(z.string()).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const seen = new Map<string, string>();
    for (const [phaseId, phase] of Object.entries(value.phases ?? {})) {
      if (!phase.loop || phase.loop === '$currentTask.id') continue;
      const previousPhase = seen.get(phase.loop);
      if (previousPhase) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phases', phaseId, 'loop'],
          message: `Loop source '${phase.loop}' is already used by phase '${previousPhase}'`,
        });
        continue;
      }
      seen.set(phase.loop, phaseId);
    }
  });

export const ProfileSchemaJsonSchema = zodToJsonSchema(ProfileSchemaSchema, {
  name: 'ProfileSchema',
  target: 'openApi3',
});
