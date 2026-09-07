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
 * Стадия — единственная единица состояния workflow.
 *
 * Стадия, объявившая `loop`, прогоняет свои `stages` по одному разу на каждую
 * задачу из этого списка, двигаясь по собственным `transitions`. Вложенность —
 * единственное отличие внутренней стадии от внешней: `allowedAgents`, `gates`,
 * `transitions`, guard-ы, эффекты и бюджеты ретраев означают на обоих уровнях
 * одно и то же, поэтому читателю нужен один набор правил, а не два.
 * См. docs/stage-model.md.
 */
export interface StageDef {
  /** Список задач, по которому стадия ходит циклом. Её `stages` выполняются на каждую задачу. */
  loop?: LoopSource;
  dispatch?: DispatchDef;
  retryBudget?: RetryBudget;
  /** Агенты, которым разрешено действовать, пока эта стадия текущая. */
  allowedAgents?: string[];
  /**
   * Гейты, которые закрывает эта стадия.
   *
   * Объявление этого поля делает стадию проверяющей: её агент обязан
   * завершиться тегом `<workflow-result>`, у которого `stage` равен id этой
   * стадии; `pass` переводит перечисленные гейты в `passed`, `fail` — в
   * `failed`. Гейт, названный здесь, но не объявленный в схеме, — ошибка
   * загрузки схемы, а не молчаливое поведение в рантайме.
   */
  gates?: string[];
  entryGuards?: string[];
  exitGuards?: string[];
  /** Стадии, выполняемые на каждую задачу, когда эта стадия объявляет `loop`. */
  stages?: Record<string, StageDef>;
  /** Переходы между собственными `stages` этой стадии. */
  transitions?: TransitionDef[];
}

/**
 * Стадия сохраняет ключи, с которыми была написана, — так же, как корневой объект.
 *
 * Не потому, что их кто-то читает: неизвестный ключ отвергает
 * `validateKnownKeys` в компиляторе — он и знает, какие ключи может нести
 * стадия, и объясняет, почему нечитаемый ключ стоит отвергнуть. Обрезка здесь
 * удаляла улику раньше, чем проверка успевала её увидеть: `allowedAgent`
 * вместо `allowedAgents` молча давал стадию вообще без ограничения агентов,
 * а проверка, написанная ровно для этого случая, стояла шагом ниже и не видела
 * ничего. Корень по той же причине всегда был `.passthrough()`; стадия ничем
 * не отличается.
 */
const StageDefSchema: z.ZodType<StageDef> = z.lazy(() =>
  z
    .object({
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
    .passthrough()
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

/**
 * Один workflow в том виде, в каком его объявляет профиль.
 *
 * Неизвестные ключи сохраняются, а не срезаются: отвергать их — работа
 * `validateKnownKeys` в компиляторе, у него список того, что может нести схема
 * и стадия, и там же объяснено, почему ключ, который никто не читает, стоит
 * отвергнуть. Отбрасывание здесь уничтожило бы улику раньше срока.
 */
export const ProfileSchemaSchema = z
  .object({
    /**
     * Схема, дельтой к которой является эта, в виде `<profile>/<file>.yaml`.
     *
     * Стадии и переходы сливаются поэлементно, а не целыми полями: потомок,
     * трогающий одну стадию, не должен молча потерять остальные родительские.
     */
    extends: z.string().optional(),

    /**
     * Стадии workflow, по id.
     *
     * Стадия может быть вложенной: `loop:` называет список задач, по которому
     * она ходит циклом, а стадии внутри — тот цикл, который проходит каждая
     * задача.
     */
    stages: z.record(StageDefSchema).optional(),

    /**
     * Стадия, выводимая из условия, а не из графа.
     *
     * Спрашивается раньше сохранённого `currentStage` и выигрывает у него:
     * стадию называет правило с наибольшим приоритетом, чьё условие истинно, и
     * только если не сработало ни одно правило — или их не объявлено вовсе —
     * остаётся стадия, записанная последним переходом.
     */
    stageAssignments: z.array(StageAssignmentRuleSchema).optional(),

    /**
     * Рёбра workflow: какая стадия может следовать за какой и при каком условии.
     *
     * `guard` — выражение над фактами сессии; `kind: pass | fail` читает
     * `requiredGates`; `consent` ждёт оператора; `effects` — то, что делает сам
     * переход по ребру, а `onFailure: retry` тратит бюджет ретраев.
     */
    transitions: z.array(TransitionDefSchema).optional(),

    /**
     * Вердикты, которых ждёт этот workflow; объявлены, чтобы `gates:` стадии
     * было с чем сверять.
     *
     * Своего списка гейтов сессия не несёт — гейт появляется в ней в тот
     * момент, когда кто-то впервые о нём высказался.
     */
    gates: z.array(GateItemSchema).optional(),

    /** Инструменты, которыми управляет workflow: когда каждый допускается и молча ли. */
    tools: z.array(ToolItemSchema).optional(),

    /** id стадии → id гейтов, за которые эта стадия отвечает. */
    gateMapping: z.record(z.array(z.string())).optional(),

    /**
     * id действия → guard, который должен быть истинным, чтобы действие допустили.
     *
     * Несущий случай — `beginMutation: "session.approved('plan')"`: никаких
     * правок, пока оператор не утвердил план.
     */
    actionGuards: z.record(z.string()).optional(),

    /**
     * Агенты, которые правят код, в масштабе всего workflow.
     *
     * Стадия, чей `allowedAgents` пускает кого-то из них, — это стадия, где
     * идёт работа; именно это делает собственный `editingAgents` задачи
     * проверяемым.
     */
    editingAgents: z.array(z.string()).optional(),

    /**
     * Агенты, которым разрешено управлять состоянием задач workflow
     * (workflow.tasks-set, workflow.tasks-set-status,
     * workflow.tasks-resolve-decision).
     * По умолчанию ['orchestrator'] — исполнитель не должен закрывать
     * собственную стадию.
     */
    taskControlAgents: z.array(z.string()).optional(),

    /**
     * Гейты, которые должны быть `passed`, чтобы разрешить коммит, и те же
     * гейты проверяет ребро `kind: pass` (а `kind: fail` требует, чтобы хотя бы
     * один из них был `failed`).
     *
     * Если поле не объявлено, движок подставляет захардкоженный `['invariants']`
     * (src/domain/engine.ts).
     */
    requiredGates: z.array(z.string()).optional(),

    /**
     * Произвольные настройки профиля.
     *
     * Проносятся через резолвер и не читаются ничем: объявление настройки
     * здесь не меняет никакого поведения.
     */
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
