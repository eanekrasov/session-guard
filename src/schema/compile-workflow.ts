import { nestedStages } from './types.ts';
import type { StageDef, TransitionDef, ResolvedSchema, StageAssignmentRule } from './types.ts';
import { parse as parseGuard } from './guard-ast.ts';

// ─── Compiled Types ──────────────────────────────────────────────────────────

/** One nested stage of a loop, addressed as `<owner>/<nested>`. */
export interface CompiledNode {
  id: string;
  /** The stage that owns the loop this node runs in. */
  owner: string;
  /** The nested stage itself. */
  stage: string;
  allowedAgents: string[];
  entryGuards: string[];
  exitGuards: string[];
}

export interface CompiledTransition {
  from: string;
  to: string;
  guard: string | null;
  effects: CompiledTransitionEffect[];
  consent: string | null;
  onFailure: 'retry' | 'terminal' | null;
}

export interface CompiledTransitionEffect {
  bumpRetry: string | null;
  maxAttempts: number | null;
  approve: string | null;
}

export interface CompiledStage {
  id: string;
  loop: string | null;
  dispatch: CompiledDispatch | null;
  retryBudget: number | null;
  nodes: CompiledNode[];
  exitGuards: string[];
  allowedAgents: string[];
}

export interface CompiledDispatch {
  strategy: 'serial' | 'parallel' | 'serial_with_overlap';
  maxConcurrent: number;
  overlapRoles: string[];
}

export interface CompiledStageAssignment {
  id: string;
  priority: number;
  condition: string;
  result: string;
}

export interface CompiledWorkflow {
  version: 1;
  stages: Record<string, CompiledStage>;
  transitions: CompiledTransition[];
  stageAssignments: CompiledStageAssignment[];
  initialStage: string;
  /**
   * Стадии, которыми workflow заканчивается: объявленные в схеме и не имеющие
   * ни одного исходящего ребра.
   *
   * Определяются объявлением, а не ключом, — тем же способом, что и начальная
   * стадия. Схема ничего нового не пишет: конец — это стадия, из которой
   * автор никуда не ведёт.
   *
   * До этого понятия не было вовсе, и «дошли до конца» было неотличимо от
   * «автор забыл ребро»: и то и другое выглядело как молчание движка на
   * каждом следующем ходу. Комментарий на этом месте обещал их вычислять и не
   * вычислял ничего.
   */
  terminalStages: string[];
}

export interface CompileError {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * The stage a session starts in: the first one the schema declares.
 *
 * This used to read the highest-priority stage assignment's result, which is
 * the opposite of an initial stage. Assignments derive where a session *is*
 * from what is true about it, and the most specific rule wins — in the base
 * workflow that is `deliveryReceipt → done`, so the "initial" stage compiled
 * to `done`. Nothing read the value, so nothing said so.
 *
 * Declaration order is what a profile author means by the first stage, and it
 * needs no session to evaluate against — which is the whole point, since there
 * is no session yet when this is asked.
 */
export function initialStageOf(stages: Record<string, StageDef> | undefined): string {
  return Object.keys(stages ?? {})[0] ?? '';
}

/**
 * Стадии, из которых workflow не ведёт никуда, — его концы.
 *
 * Считаются только переходы верхнего уровня. Ребро внутри цикла с `to: done`
 * говорит «задача закончена» и стадии `done` не касается вовсе
 * (`task-movement.ts`), так что смешивать эти два `done` нельзя.
 */
export function terminalStagesOf(
  stages: Record<string, StageDef> | undefined,
  transitions: TransitionDef[] | undefined
): string[] {
  const ids = Object.keys(stages ?? {});
  const departures = new Set((transitions ?? []).map((transition) => transition.from));
  return ids.filter((id) => !departures.has(id));
}

// ─── Compiler ────────────────────────────────────────────────────────────────

/**
 * Compile a resolved schema into a `CompiledWorkflow`.
 *
 * Normalises defaults, validates cross-references, and produces
 * a deterministic execution contract. Rejects unsupported declarations.
 */
export function compileWorkflow(schema: ResolvedSchema): {
  workflow: CompiledWorkflow;
  errors: CompileError[];
} {
  const errors: CompileError[] = [];

  // Collect stage IDs
  const stageIds = new Set(Object.keys(schema.stages ?? {}));

  // Build compiled stages with normalised defaults
  const compiledStages: Record<string, CompiledStage> = {};
  for (const [stageId, stageDef] of Object.entries(schema.stages ?? {})) {
    const compiledNodes = compileNodes(stageId, stageDef, stageIds, errors);

    compiledStages[stageId] = {
      id: stageId,
      loop: stageDef.loop ?? null,
      dispatch: compileDispatch(stageDef.dispatch, errors),
      retryBudget: stageDef.retryBudget?.maximum ?? null,
      nodes: compiledNodes,
      exitGuards: stageDef.exitGuards ?? [],
      allowedAgents: stageDef.allowedAgents ?? [],
    };
  }

  for (const [stageId, stageDef] of Object.entries(schema.stages ?? {})) {
    validateNestedStages(stageId, stageDef, errors);
    validateActions(`stages.${stageId}`, stageDef, errors);
  }

  // Every expression the workflow will ever evaluate, parsed now rather than
  // read as `false` for ever at runtime.
  validateGuardSyntax(schema, errors);

  // Стадия, до которой не дойти, — это объявление, которое никогда не
  // исполнится. Молчать об этом особенно дорого с тех пор, как стадия несёт
  // `actions:`: недостижимая `commit` означает workflow, который не может
  // доставить, и ни одной жалобы при загрузке.
  validateReachability(schema, errors);

  // Keys nobody reads, reported rather than ignored.
  validateKnownKeys(schema, errors);

  // Build compiled transitions
  const compiledTransitions = compileTransitions(schema.transitions ?? [], stageIds, errors);

  // Build compiled stage assignments
  const compiledAssignments = compileAssignments(schema.stageAssignments ?? [], errors);

  const initialStage = initialStageOf(schema.stages);

  return {
    workflow: {
      version: 1,
      stages: compiledStages,
      transitions: compiledTransitions,
      stageAssignments: compiledAssignments,
      initialStage,
      terminalStages: terminalStagesOf(schema.stages, schema.transitions),
    },
    errors,
  };
}

/** The transition target that ends a task's work; never a stage of its own. */
const TASK_DONE = 'done';

/**
 * Fields a schema may declare. Anything else is reported.
 *
 * `ProfileSchemaSchema` is `.passthrough()` — a typo, or a key from an older
 * vocabulary, parses cleanly and is then read by nobody. That is how
 * `android.yaml` carried a dead `phases:` block for months while every test
 * stayed green. Reporting them here rather than tightening the parser keeps
 * `ResolvedSchema`'s index signature working and gives the author one funnel,
 * with a path and a name.
 */
const SCHEMA_KEYS = new Set([
  // Added by the resolver, not authored: the schema's own name and the file
  // it came from.
  'id',
  'source',
  'extends',
  'stages',
  'stageAssignments',
  'transitions',
  'editingAgents',
  'taskControlAgents',
]);

const STAGE_KEYS = new Set([
  'loop',
  'dispatch',
  'retryBudget',
  'allowedAgents',
  'actions',
  'gates',
  'entryGuards',
  'exitGuards',
  'stages',
  'transitions',
]);

/**
 * Каждая объявленная стадия должна быть достижима.
 *
 * Обход от начальной стадии по рёбрам. Стадия, названная результатом правила
 * `stageAssignments`, тоже достижима — эти правила назначают стадию выражением,
 * минуя граф, и без их учёта проверка ругалась бы на исправные профили.
 *
 * Вложенные стадии цикла проверяются отдельно и по своим рёбрам: старт — первая
 * объявленная, `done` — не стадия, а «задача закончилась». Цикл, не объявивший
 * переходов вовсе, ходит по порядку объявления — там достижимы все, и проверка
 * пропускается. Это и поймал корпус фикстур на первой версии проверки.
 *
 */
function validateReachability(schema: ResolvedSchema, errors: CompileError[]): void {
  const stages = schema.stages ?? {};
  const ids = Object.keys(stages);
  if (ids.length === 0) return;

  const walk = (
    all: string[],
    start: string | undefined,
    edges: Array<{ from?: string; to?: string }>,
    seeds: string[]
  ): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(start ? [start] : []), ...seeds].filter((id) => all.includes(id));
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of edges) {
        if (edge.from === id && edge.to && all.includes(edge.to)) queue.push(edge.to);
      }
    }
    return seen;
  };

  const assigned = (schema.stageAssignments ?? []).map((rule) => rule.result);
  const reached = walk(ids, initialStageOf(stages), schema.transitions ?? [], assigned);
  for (const id of ids) {
    if (reached.has(id)) continue;
    errors.push({
      severity: 'error',
      path: `stages.${id}`,
      message: `Stage '${id}' is declared but nothing reaches it: no transition leads here from '${initialStageOf(stages)}', and no stage assignment names it`,
    });
  }

  validateTermination(schema, errors);

  for (const [stageId, stage] of Object.entries(stages)) {
    const nested = Object.keys(stage.stages ?? {});
    if (nested.length === 0) continue;
    // Цикл без объявленных переходов двигается по порядку объявления
    // (`nextTaskStage`, ветка `transitions.length === 0`): каждая стадия ведёт
    // к следующей, последняя завершает задачу. Достижимы все, проверять нечего.
    const innerEdges = stage.transitions ?? [];
    if (innerEdges.length === 0) continue;
    const inner = walk(nested, nested[0], innerEdges, []);
    for (const id of nested) {
      if (inner.has(id)) continue;
      errors.push({
        severity: 'error',
        path: `stages.${stageId}.stages.${id}`,
        message: `Nested stage '${id}' is declared but nothing reaches it: the loop starts at '${nested[0]}' and no transition leads here`,
      });
    }
  }
}

/**
 * Из каждой стадии должен быть путь к концу workflow.
 *
 * Обратная сторона достижимости. Прямая проверка ловит стадию, в которую не
 * попасть; эта — стадию, из которой не выйти. Забытое ребро делало сессию
 * неподвижной ровно так же, как выглядит честно завершённый workflow: движок
 * молча отвечал «No outgoing transitions from X» и никому этого не показывал.
 *
 * Схема без единого конца — отдельная ошибка: такой workflow не заканчивается
 * никогда, и это почти наверняка не то, что имел в виду автор.
 *
 * При объявленных `stageAssignments` попроцедурная проверка не делается.
 * `deriveStage` выбирает стадию по условию, а не по рёбрам, так что сессия
 * может уйти со стадии, из которой не ведёт ни одно ребро, — назвать такую
 * тупиком значило бы соврать.
 */
function validateTermination(schema: ResolvedSchema, errors: CompileError[]): void {
  const stages = schema.stages ?? {};
  const ids = Object.keys(stages);
  if (ids.length === 0) return;

  const transitions = schema.transitions ?? [];
  const terminals = terminalStagesOf(stages, transitions);

  if (terminals.length === 0) {
    errors.push({
      severity: 'error',
      path: 'stages',
      message:
        'This workflow has no end: every declared stage has an outgoing transition, so a session can never come to rest. Declare a stage nothing leads out of.',
    });
    return;
  }

  if ((schema.stageAssignments ?? []).length > 0) return;

  const canFinish = new Set<string>(terminals);
  let grew = true;
  while (grew) {
    grew = false;
    for (const transition of transitions) {
      if (!transition.from || !transition.to) continue;
      if (canFinish.has(transition.from) || !canFinish.has(transition.to)) continue;
      if (!ids.includes(transition.from)) continue;
      canFinish.add(transition.from);
      grew = true;
    }
  }

  for (const id of ids) {
    if (canFinish.has(id)) continue;
    errors.push({
      severity: 'error',
      path: `stages.${id}`,
      message: `Stage '${id}' has no way to finish: no chain of transitions leads from here to any stage the workflow ends at (${terminals.join(', ')})`,
    });
  }
}

function validateKnownKeys(schema: ResolvedSchema, errors: CompileError[]): void {
  for (const key of Object.keys(schema)) {
    // The resolver adds provenance of its own; only authored keys are checked.
    if (key.startsWith('_') || SCHEMA_KEYS.has(key)) continue;
    errors.push({
      severity: 'error',
      path: key,
      message: `Unknown key "${key}". A key nothing reads is silently ignored; allowed: ${[
        ...SCHEMA_KEYS,
      ]
        .filter((k) => k !== 'id' && k !== 'source')
        .sort()
        .join(', ')}`,
    });
  }

  const walkStage = (path: string, stage: StageDef): void => {
    for (const key of Object.keys(stage)) {
      if (STAGE_KEYS.has(key)) continue;
      errors.push({
        severity: 'error',
        path: `${path}.${key}`,
        message: `Unknown key "${key}" on a stage; allowed: ${[...STAGE_KEYS].sort().join(', ')}`,
      });
    }
    for (const [nestedId, nested] of Object.entries(stage.stages ?? {})) {
      walkStage(`${path}.stages.${nestedId}`, nested);
    }
  };

  for (const [stageId, stage] of Object.entries(schema.stages ?? {})) {
    walkStage(`stages.${stageId}`, stage);
  }
}

/**
 * Parse every guard expression the workflow declares.
 *
 * The compiler exists to turn silence into an error, and this was its widest
 * hole: `"session.gates.((("` compiled clean and then evaluated to `false` for
 * ever, so the transition simply never fired. The evaluator reports the parse
 * failure at runtime through `onError`, which is far too late — nothing
 * refused the profile at load.
 */
function validateGuardSyntax(schema: ResolvedSchema, errors: CompileError[]): void {
  const check = (path: string, expression: string | undefined): void => {
    if (expression === undefined || expression.trim() === '') return;
    try {
      parseGuard(expression);
    } catch (err) {
      errors.push({
        severity: 'error',
        path,
        message: `Guard expression does not parse: ${expression} (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  };

  for (const [index, rule] of (schema.stageAssignments ?? []).entries()) {
    check(`stageAssignments[${index}].condition`, rule.condition);
  }
  for (const [index, transition] of (schema.transitions ?? []).entries()) {
    check(`transitions[${index}].guard`, transition.guard);
  }

  const walkStage = (path: string, stage: StageDef): void => {
    for (const [index, entry] of (stage.actions ?? []).entries()) {
      check(`${path}.actions[${index}].guard`, entry.guard);
    }
    for (const [index, expression] of (stage.entryGuards ?? []).entries()) {
      check(`${path}.entryGuards[${index}]`, expression);
    }
    for (const [index, expression] of (stage.exitGuards ?? []).entries()) {
      check(`${path}.exitGuards[${index}]`, expression);
    }
    for (const [index, transition] of (stage.transitions ?? []).entries()) {
      check(`${path}.transitions[${index}].guard`, transition.guard);
    }
    for (const [nestedId, nested] of Object.entries(stage.stages ?? {})) {
      walkStage(`${path}.stages.${nestedId}`, nested);
    }
  };

  for (const [stageId, stage] of Object.entries(schema.stages ?? {})) {
    walkStage(`stages.${stageId}`, stage);
  }
}

/**
 * Проверить объявления действий на стадии и во всех вложенных.
 *
 * Два правила, и оба про то, что рантайм не сможет исполнить написанное.
 *
 * Первое — дискриминатор обязан подходить действию. Пути работают только для
 * `edit`: `edit`, `write` и `apply_patch` называют цель в аргументах, и
 * `scopeBefore` именно так их и фильтрует, а `bash` получает от хоста лишь
 * `workdir` — пути в аргументах нет. Маску для `bash` можно записать, но
 * нельзя выполнить, и в этом репозитории поле, которое читается никем, уже
 * дорого обходилось. Симметрично `commands:` бессмысленны вне `bash`.
 *
 * Третье правило про `delivers`: пометка живёт только на `bash`, потому что
 * доставка приезжает шелл-командой, и требует `commands`. Без них весь `bash`
 * стадии поехал бы мимо жизненного цикла мутации — почти наверняка не то, что
 * автор имел в виду.
 *
 * Второе — маска каталога без `/**` не покрывает ничего внутри себя:
 * `matchesScope` якорит и путь, и маску, так что `src/auth` не совпадёт с
 * `src/auth/login.ts`. Маска без метасимволов почти наверняка опечатка.
 */
function validateActions(path: string, stage: StageDef, errors: CompileError[]): void {
  for (const [index, entry] of (stage.actions ?? []).entries()) {
    const at = `${path}.actions[${index}]`;

    if (entry.paths !== undefined && entry.action !== 'edit') {
      errors.push({
        severity: 'error',
        path: at,
        message: `'paths' is only meaningful for action 'edit'; '${entry.action}' carries no path in its arguments, so the mask could never be enforced`,
      });
    }
    if (entry.commands !== undefined && entry.action !== 'bash') {
      errors.push({
        severity: 'error',
        path: at,
        message: `'commands' is only meaningful for action 'bash', not '${entry.action}'`,
      });
    }
    if (entry.delivers && entry.action !== 'bash') {
      errors.push({
        severity: 'error',
        path: at,
        message: `'delivers' is only meaningful for action 'bash'; a delivery arrives as a shell command, not as '${entry.action}'`,
      });
    }
    if (entry.delivers && (entry.commands ?? []).length === 0) {
      errors.push({
        severity: 'error',
        path: at,
        message: `'delivers' needs 'commands': without them every bash call on this stage would be routed as a delivery, skipping the mutation lifecycle`,
      });
    }
    for (const [maskIndex, mask] of (entry.paths ?? []).entries()) {
      if (!/[*?[\]{}]/.test(mask)) {
        errors.push({
          severity: 'error',
          path: `${at}.paths[${maskIndex}]`,
          message: `Mask '${mask}' has no wildcard, so it matches that one path and nothing inside it. Write '${mask}/**' to cover a directory`,
        });
      }
    }
    for (const [commandIndex, pattern] of (entry.commands ?? []).entries()) {
      try {
        new RegExp(pattern);
      } catch (err) {
        errors.push({
          severity: 'error',
          path: `${at}.commands[${commandIndex}]`,
          message: `Command pattern does not compile as a regular expression: ${pattern} (${err instanceof Error ? err.message : String(err)})`,
        });
      }
    }
  }

  for (const [nestedId, nested] of Object.entries(stage.stages ?? {})) {
    validateActions(`${path}.stages.${nestedId}`, nested, errors);
  }
}

/**
 * Check a stage's own stages and transitions.
 *
 * These are the rules the runtime would otherwise discover one failed workflow
 * at a time: a transition to a stage that does not exist, or a retry budget
 * belonging to something other than the task.
 */
function validateNestedStages(stageId: string, stageDef: StageDef, errors: CompileError[]): void {
  const nested = nestedStages(stageDef);
  const nestedIds = new Set(nested.map((entry) => entry.id));

  if (stageDef.loop && (stageDef.transitions?.length ?? 0) > 0) {
    const ends = (stageDef.transitions ?? []).some((transition) => transition.to === TASK_DONE);
    if (!ends) {
      errors.push({
        severity: 'error',
        path: `stages.${stageId}.transitions`,
        message: `Loop "${stageId}" declares transitions but none of them reaches "${TASK_DONE}", so no task can ever finish it`,
      });
    }
  }

  if (stageDef.loop && nested.length === 0) {
    errors.push({
      severity: 'error',
      path: `stages.${stageId}`,
      message: `Stage "${stageId}" cycles over "${stageDef.loop}" but declares no stages to run`,
    });
  }

  if (!stageDef.loop && (stageDef.transitions?.length ?? 0) > 0) {
    errors.push({
      severity: 'error',
      path: `stages.${stageId}.transitions`,
      message: `Stage "${stageId}" declares transitions but no loop to move a task through`,
    });
  }

  // A nested stage's own gates are checked by its own call below, under the
  // same path this loop would have produced — checking them here as well
  // reported every one of them twice, which `toContain` in the tests could not
  // see.
  for (const entry of nested) {
    validateNestedStages(`${stageId}.stages.${entry.id}`, entry, errors);
  }

  for (const transition of stageDef.transitions ?? []) {
    // `done` is not a stage: it is how a loop says the task's work is over.
    const endpoints = [transition.from, ...(transition.to === TASK_DONE ? [] : [transition.to])];
    for (const endpoint of endpoints) {
      if (!nestedIds.has(endpoint)) {
        errors.push({
          severity: 'error',
          path: `stages.${stageId}.transitions`,
          message: `Transition ${transition.from} → ${transition.to} names "${endpoint}", which is not a stage of "${stageId}"`,
        });
      }
    }
    for (const effect of transition.effects ?? []) {
      if (effect.bumpRetry !== undefined && effect.bumpRetry !== 'task.id') {
        errors.push({
          severity: 'error',
          path: `stages.${stageId}.transitions`,
          message: `Transition ${transition.from} → ${transition.to} bumps "${effect.bumpRetry}"; inside a loop the budget is the task's own, written as task.id`,
        });
      }
    }
  }
}

function compileNodes(
  stageId: string,
  stageDef: StageDef,
  _stageIds: Set<string>,
  _errors: CompileError[]
): CompiledNode[] {
  return nestedStages(stageDef).map((stage) => ({
    id: `${stageId}/${stage.id}`,
    owner: stageId,
    stage: stage.id,
    allowedAgents: stage.allowedAgents ?? stageDef.allowedAgents ?? [],
    entryGuards: stage.entryGuards ?? [],
    exitGuards: stage.exitGuards ?? [],
  }));
}

function compileDispatch(
  dispatch: StageDef['dispatch'],
  _errors: CompileError[]
): CompiledDispatch | null {
  if (!dispatch) return null;
  if (typeof dispatch === 'object' && 'strategy' in dispatch) {
    const d = dispatch as {
      strategy: 'serial' | 'parallel' | 'serial_with_overlap';
      maxConcurrent?: number;
      overlapRoles?: string[];
    };
    return {
      strategy: d.strategy,
      maxConcurrent: d.maxConcurrent ?? (d.strategy === 'serial' ? 1 : 2),
      overlapRoles: d.overlapRoles ?? [],
    };
  }
  return null;
}

function compileTransitions(
  transitions: TransitionDef[],
  stageIds: Set<string>,
  errors: CompileError[]
): CompiledTransition[] {
  return transitions.map((t, i) => {
    if (!stageIds.has(t.from)) {
      errors.push({
        severity: 'error',
        path: `transitions[${i}]`,
        message: `Unknown source stage '${t.from}'`,
      });
    }
    if (!stageIds.has(t.to)) {
      errors.push({
        severity: 'error',
        path: `transitions[${i}]`,
        message: `Unknown target stage '${t.to}'`,
      });
    }
    for (const effect of t.effects ?? []) {
      // The mirror of the loop rule below: inside a loop the budget is always
      // the task's own, and at workflow level there is no task to name.
      if (effect.bumpRetry === 'task.id') {
        errors.push({
          severity: 'error',
          path: `transitions[${i}]`,
          message: `Transition ${t.from} → ${t.to} bumps "task.id", but a workflow-level transition has no task; name a workflow budget instead`,
        });
      }
    }

    return {
      from: t.from,
      to: t.to,
      guard: t.guard ?? null,
      effects: (t.effects ?? []).map((e) => ({
        bumpRetry: e.bumpRetry ?? null,
        maxAttempts: e.maxAttempts ?? null,
        approve: e.approve ?? null,
      })),
      consent: typeof t.consent === 'string' ? t.consent : (t.consent?.type ?? null),
      onFailure: t.onFailure ?? null,
    };
  });
}

function compileAssignments(
  assignments: StageAssignmentRule[],
  _errors: CompileError[]
): CompiledStageAssignment[] {
  return [...assignments]
    .sort((a, b) => b.priority - a.priority)
    .map((a) => ({
      id: a.id,
      priority: a.priority,
      condition: a.condition,
      result: a.result,
    }));
}
