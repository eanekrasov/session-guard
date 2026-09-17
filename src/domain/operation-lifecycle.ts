import { isOpenLoopRun, nextLoopRunId, findTask } from '../session/helpers.ts';
import type { WorkflowSession, ActiveOperation, LoopRun } from '../session/session-schema.ts';
import { MUTATION_TTL_MS } from './evidence.ts';

function getActiveOperations(session: WorkflowSession): ActiveOperation[] {
  return Object.values(session.activeOperations ?? {});
}

function getActiveOperation(session: WorkflowSession, callId?: string): ActiveOperation | null {
  if (callId) return session.activeOperations?.[callId] ?? null;

  const operations = getActiveOperations(session);
  return operations.length === 1 ? operations[0] : null;
}

/**
 * Where a synthesised run starts: the first nested stage of the loop that owns
 * `listKey`. Given by the caller, because only the caller holds the compiled
 * workflow.
 */
export type ResolveInitialStage = (listKey: string) => string | null;

/**
 * Что удалось решить о прогоне для этого хода.
 *
 * Три исхода, а не два. `ambiguous` — прогонов или задач-кандидатов несколько,
 * и выбрать за автора нельзя: ход отказывается. `none` — прогона нет и быть не
 * должно, стадия не цикл. Раньше оба случая возвращали `null`, и попытка
 * разрешить работу вне цикла заодно разрешила бы правку при двух
 * одновременных задачах — без привязки к `writeScope` любой из них.
 */
type MutationRunResolution =
  { kind: 'run'; run: LoopRun } | { kind: 'ambiguous'; reason: string } | { kind: 'none' };

/**
 * `currentListKey` — список цикла стадии, на которой идёт ход, когда она цикл.
 * Строка сужает кандидатов до своего списка; `null`/`undefined` (стадия не
 * цикл, или вызывающий не сказал) оставляют прежний просмотр всех списков.
 */
function resolveMutationRun(
  session: WorkflowSession,
  resolveInitialStage?: ResolveInitialStage,
  currentListKey?: string | null
): MutationRunResolution {
  session.loopRuns ??= {};
  session.activeOperations ??= {};
  const openRuns = Object.values(session.loopRuns).filter((run) => isOpenLoopRun(run));
  if (openRuns.length === 1) return { kind: 'run', run: openRuns[0]! };
  if (openRuns.length > 1) {
    return { kind: 'ambiguous', reason: `${openRuns.length} open task runs` };
  }

  // Только список цикла, в котором сессия сейчас находится, когда он известен.
  //
  // Ход бывает и до первого диспатча — оркестратор правит, ещё стоя на стадии
  // перед циклом. Тогда стадия своего списка не называет (`null`), и кандидаты
  // ищутся по всем: привязать правку к единственной задаче в работе строго
  // лучше, чем оставить её без области записи вовсе.
  //
  // Раньше кандидаты собирались по ВСЕМ спискам сразу. Со схемой об одном
  // цикле это незаметно, а с двумя последовательными — `implementation`, а
  // потом `test_suite` — ход на первом цикле мог синтезировать прогон по
  // задаче второго, ещё не начатого: единственная runnable-задача нашлась бы
  // в чужом списке. Стадия называет свой список сама, и спрашивать надо его.
  const lists = Object.entries(session.tasks ?? {}).filter(
    ([listKey]) => typeof currentListKey !== 'string' || listKey === currentListKey
  );
  const runnableTasks = lists.flatMap(([listKey, tasks]) =>
    tasks
      .filter((task) => task.status === 'pending' || task.status === 'running')
      .map((task) => ({ listKey, task }))
  );
  if (runnableTasks.length === 0) return { kind: 'none' };
  if (runnableTasks.length > 1) {
    return { kind: 'ambiguous', reason: `${runnableTasks.length} runnable tasks` };
  }

  const [{ listKey, task }] = runnableTasks as [
    { listKey: string; task: { id: string; status: string } },
  ];

  // A run has to start in a stage the profile declares. Writing a literal here
  // — this used to say `stage: 'mutation'` — parks the task in a stage no
  // workflow has, and every later dispatch for it is refused for ever, because
  // admission looks the run's stage up among the loop's nested stages. Refuse
  // now, with a reason, rather than poison the task silently.
  const stage = resolveInitialStage?.(listKey);
  if (!stage) {
    throw new Error(
      `Cannot start a mutation for ${task.id}: no first stage resolved for the loop over "${listKey}"`
    );
  }

  const runId = nextLoopRunId(session);
  const run: LoopRun = {
    id: runId,
    taskId: task.id,
    listKey,
    ancestry: [],
    stage,
    status: 'running',
    gates: {},
    round: 0,
  };
  session.loopRuns[runId] = run;
  task.status = 'running';
  return { kind: 'run', run };
}

/**
 * Begin a new mutation. Throws when an active non-expired operation exists.
 *
 * Every verdict about the work is cleared: verifications and the gates of the
 * task being edited. A gate is evidence
 * about the code as it was, and an edit is exactly what makes that code no
 * longer the code. Editing twice inside one stage is ordinary — an architect
 * reworking a plan with the operator does it every time — so each edit must
 * start from no verdicts rather than inherit the last one's.
 */
export function beginMutation(
  session: WorkflowSession,
  callId: string,
  agent: string = 'unknown',
  resolveInitialStage?: ResolveInitialStage,
  currentListKey?: string | null,
  now: string = new Date().toISOString()
): void {
  for (const operation of getActiveOperations(session)) {
    if (isExpiredMutation(session, operation.callId, now)) {
      delete session.activeOperations[operation.callId];
    }
  }

  // Only another *mutation* occupies the slot. A dispatched `task` is an
  // operation too, but the writes it performs are exactly what it was
  // dispatched to do — refusing them because the dispatch is open would refuse
  // all delegated work. This was only ever passable because lock release
  // deleted the task's operation to make room, which lost the task.
  const existing = getActiveOperations(session).find((op) => op.kind !== 'task');
  if (existing) {
    throw new Error(`Active operation already exists: ${existing.callId}`);
  }

  // Прогона может не быть — и это законно. Стадия без `loop:` тоже стадия, на
  // ней тоже работают, и раньше такой ход умирал здесь с внутренней ошибкой:
  // агент видел «Cannot resolve a single workflow task run for mutation» и
  // уходил просить оператора сделать работу руками. Ход без прогона получает
  // ту же машинерию — свой baseline-кадр, дифф, проверку области записи и
  // вердикт, — а вердикту домом становится сессия (`finishMutation`).
  //
  // Неоднозначность — по-прежнему отказ: выбрать за автора, к какому из двух
  // прогонов отнести правку, значит проверить её чужой областью записи.
  const resolution = resolveMutationRun(session, resolveInitialStage, currentListKey);
  if (resolution.kind === 'ambiguous') {
    throw new Error(`Cannot resolve a single workflow task run for mutation: ${resolution.reason}`);
  }
  const run = resolution.kind === 'run' ? resolution.run : null;

  session.activeOperations[callId] = {
    callId,
    ...(run ? { runId: run.id, taskId: run.taskId } : {}),
    agent,
    kind: 'mutation',
    startedAt: now,
    status: 'running',
    round: run?.round ?? 0,
  };

  // Правка делает прежние вердикты вердиктами о коде, которого больше нет, —
  // и это верно на любой стадии, а не только внутри цикла.
  session.verifications = [];
  if (run) run.gates = {};
  else session.checks = undefined;
}

/**
 * Завершить ход: записать вердикт проверок и снять активную операцию.
 *
 * `passed` считает вызывающий (`processScopeAndInvariants`) — он складывает
 * четыре причины: упавший инструмент, запись вне `writeScope`, несчитанный
 * дифф и нарушенные инварианты. Вердикт кладётся на прогон задачи, а не в
 * гейт: гейты пишет агент через `<workflow-result>`, и любой объявленный
 * стадией гейт он может выставить себе сам. Этот вердикт движок выносит,
 * посмотрев на диск, и потому он ценен независимостью от рассказа агента.
 *
 * Ход вне цикла задачи вердикт не записывает — писать его некуда.
 */
export function finishMutation(session: WorkflowSession, passed: boolean, callId?: string): void {
  const operation = getActiveOperation(session, callId);
  if (!operation) return;

  const run = operation.runId ? session.loopRuns?.[operation.runId] : undefined;
  // Внутри цикла вердикт кладётся на прогон задачи и читается как
  // `task.checks`; снаружи — на сессию, и читается как `session.checks`. Одна
  // и та же проверка, разные адресаты, потому что судить больше некого.
  if (run) run.checks = passed ? 'passed' : 'failed';
  else session.checks = passed ? 'passed' : 'failed';

  delete session.activeOperations[operation.callId];
}

/**
 * True when the active operation has been running longer than MUTATION_TTL_MS.
 *
 * `now` is the same clock source `beginMutation` stamps `startedAt` from, so a
 * caller that injects time for the start also gets a TTL decision measured
 * against that time rather than the wall clock.
 */
export function isExpiredMutation(
  session: WorkflowSession,
  callId?: string,
  now: string = new Date().toISOString()
): boolean {
  const operation = getActiveOperation(session, callId);
  if (!operation) return false;

  const startedAt = Date.parse(operation.startedAt);
  if (isNaN(startedAt)) return false;

  const currentTime = Date.parse(now);
  if (isNaN(currentTime)) return false;

  return currentTime - startedAt >= MUTATION_TTL_MS;
}

/** Clear the active mutation. Safe no-op when already null. */
export function clearActiveMutation(session: WorkflowSession, callId?: string): void {
  const operation = getActiveOperation(session, callId);
  if (!operation) return;
  delete session.activeOperations[operation.callId];
}
