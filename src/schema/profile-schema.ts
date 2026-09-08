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
export type ActionEntry = z.infer<typeof ActionEntrySchema>;

/**
 * Одно объявление действия на стадии.
 *
 * Действий на стадии может быть несколько, в том числе несколько записей на
 * одно действие: `edit` разделяется масками путей, `bash` — регулярками по
 * команде. Поэтому список, а не карта по имени действия.
 */
/**
 * Закрытый словарь действий. Каждое имя — инструмент хоста, а не назначение.
 *
 * Здесь был ещё `commit`, и это была ошибка уровня: инструмента `commit` не
 * существует, коммит приезжает обычным `bash`. Отказ на стадии коммита из-за
 * этого сообщал автору про `bash`, хотя тот написал `commit`. Доставку теперь
 * помечает `delivers` на самой записи.
 *
 * `edit` — имя семейства: под ним `edit`, `write` и `apply_patch`. Все трое
 * называют цель в аргументах, и разделять их значило бы писать «любую правку»
 * тремя записями.
 *
 * Намеренно без `dispatch`: у допуска задач своя машинерия (`allowedAgents`,
 * правила admission), и заводить ключ, который никто не читает, значит
 * повторить историю `verifiers` и `terminalStages`.
 */
export const ACTION_IDS = ['edit', 'bash'] as const;
export type ActionId = (typeof ACTION_IDS)[number];

const ActionEntrySchema = z.object({
  action: z.enum(ACTION_IDS),
  paths: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  /**
   * Этот вызов — доставка, а не обычная работа.
   *
   * Ядро по этому признаку не входит в жизненный цикл мутации, выдаёт
   * `deliveryPermit` до вызова и сверяет HEAD с закоммиченными файлами после.
   * Раньше «этот bash есть коммит» решала зашитая проверка на имя
   * `commit-task.ts`; теперь это строчка в схеме.
   */
  delivers: z.boolean().optional(),
  guard: z.string().optional(),
});

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
   * Что на этой стадии можно делать и при каком условии.
   *
   * Вторая ось рядом с переходами: те отвечают «можно ли отсюда уйти», эта —
   * «можно ли сделать вот это, оставаясь на месте». Отсутствие поля означает
   * отсутствие ограничений; объявленный список исчерпывающий.
   */
  actions?: ActionEntry[];
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
      actions: z.array(ActionEntrySchema).optional(),
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
     * `guard` — выражение над фактами сессии; `consent` ждёт оператора;
     * `effects` — то, что делает сам переход по ребру, а `onFailure: retry`
     * тратит бюджет ретраев.
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
