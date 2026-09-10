import type { WorkflowSession } from '../session/session-schema.ts';

// Чистая логика секции workflow для TUI-плагина.
// Без JSX: импортируется и плагином, и bun-тестами (scripts/tui.test.ts).
// Контракт: specs/002-sidebar-state-display/contracts/runtime-state-read.md

/**
 * The base workflow's outer stages, in graph order, used only to guess the
 * neighbours of the current stage when the host does not supply them.
 *
 * It listed `code`, `review` and `qa` until the stage model moved them: `code`
 * became a nested stage of the `execution` loop and `review` / `qa` became
 * gates that `verify` and `validation` declare. `indexOf` therefore missed on
 * every real stage, and the sidebar told the operator that the stage after
 * `execution` was `planning`.
 *
 * Still the base profile's chain rather than the running one — the TUI reads a
 * session file, which carries `profileId` and `currentStage` but no graph.
 * `neighbors()` in index.tsx is the accurate source; this is its fallback.
 */
export const STAGES = [
  'planning',
  'tasks_ready',
  'execution',
  'validation',
  'commit',
  'done',
  'failed',
] as const;

export type Stage = string;

/**
 * Почему панель не показывает состояние.
 *
 * Значение осталось одно. Прежние семь описывали формы, до которых разбор
 * больше не доходит: битый текст, чужую структуру, отсутствующий
 * `sessionId` — на всё это `readSession` отвечает `null` раньше, и сюда
 * приходит уже разобранная схемой сессия.
 */
export type IdleReason = 'no_stage';

export interface GateInfo {
  id: string;
  status: string;
}

/** One open call, as the sidebar needs it. */
export interface ActiveOperationInfo {
  callId: string;
  taskId?: string;
  agent: string;
  outputReady: boolean;
}

export interface RetryInfo {
  key: string;
  attempts: number;
  maximum: number;
}

export type Tui = {
  rootSessionID: string;
  stage: Stage;
  prevStage: Stage | null;
  nextStage: Stage | null;
  revision: number;
  completedTasks: number;
  totalTasks: number;
  /** Every call the session is holding open. Verifiers run in parallel, so this is a list. */
  activeOperations: ActiveOperationInfo[];
  gates: GateInfo[];
  /** Gates of each task still in flight — a verdict belongs to the work it judged. */
  taskGates: TaskGateInfo[];
  retryBudgets: RetryInfo[];
  raw: Record<string, unknown>;
};

/** One task's verdicts, as the operator needs to see them: whose, and where. */
export type TaskGateInfo = {
  taskId: string;
  stage: string;
  status: string;
  gates: GateInfo[];
  /**
   * Вердикт движка о последнем ходе задачи (`run.checks`).
   *
   * Показывается наравне с гейтами, потому что решает ровно то же — выйдет ли
   * задача со стадии, — но вносит его не агент, а плагин. Задача, застрявшая в
   * `code` с `failed`, гейтов не имеет вовсе, и без этой строки оператор не
   * видел бы ни задачи, ни причины.
   */
  checks?: string;
};

/**
 * The stage the session is in.
 *
 * `currentStage` is authoritative: the engine derives the stage (which may go
 * through `stageAssignments` and guards) and `runtime.ts` persists the result
 * there, so reading it is seeing the engine's own answer rather than guessing
 * at one. Profiles may name stages whatever they like, so no list is applied.
 *
 * The fallback that used to sit here read `planApproved`, `planDeclined`,
 * `bugVerified`, `commitHash` and `commitPermit` — none of which the session
 * schema has — and returned pre-stage-model names like `code` and `qa`. It was
 * unreachable anyway: `currentStage` carries a schema default.
 */
/**
 * Открытые вызовы сессии.
 *
 * Читалось `record.activeMutation` — одиночный объект и поле, которого у схемы
 * сессии нет, — поэтому строка «active» в боковой панели не появлялась никогда.
 * Сессия держит карту по идентификатору вызова, а на стадии проверки работают
 * несколько агентов сразу, так что их бывает больше одного.
 */
function parseActiveOperations(
  operations: WorkflowSession['activeOperations']
): ActiveOperationInfo[] {
  return Object.entries(operations ?? {}).map(([callId, operation]) => ({
    callId: operation.callId !== '' ? operation.callId : callId,
    taskId: operation.taskId,
    agent: operation.agent,
    outputReady: operation.result === 'output_ready',
  }));
}

export type ParseResult = { ok: true; value: Tui } | { ok: false; reason: IdleReason };

/**
 * Вид боковой панели по уже разобранной сессии.
 *
 * Принимает объект, а не текст. Раньше сюда приходила строка, и функция сама
 * защищалась от всего подряд: битого JSON, `gates` объектом вместо массива,
 * `tasks` массивом вместо карты, `rootSessionID` вместо `sessionId`, статуса
 * `committed`, которого нет среди статусов задачи. Ни одна из этих форм не
 * доходит сюда с тех пор, как читатель (`readSession`) валидирует сессию
 * схемой и на всё перечисленное отвечает `null`. Толерантность оставалась
 * живой только в тестах, которые её и кормили.
 *
 * Единственный настоящий отказ — стадии нет: поле есть у схемы, но пустая
 * строка стадией не является.
 */
export function parseRuntimeState(session: WorkflowSession): ParseResult {
  const finalStage = session.currentStage;
  if (finalStage === '') {
    return { ok: false, reason: 'no_stage' };
  }

  const tasks = Object.values(session.tasks ?? {}).flat();
  const completedCount = tasks.filter((task) => task.status === 'completed').length;

  // Соседи по графу. Стадия, которой цепочка не знает — профиль вправе назвать
  // свою, — соседей не имеет: `indexOf` возвращает -1, а -1 удовлетворял
  // условию `stageIndex < STAGES.length - 1`, и панель предлагала STAGES[0]
  // следующей стадией для каждой неизвестной.
  const stageIndex = (STAGES as readonly string[]).indexOf(finalStage);
  const prevStage: Stage | null = stageIndex > 0 ? STAGES[stageIndex - 1] : null;
  const nextStage: Stage | null =
    stageIndex >= 0 && stageIndex < STAGES.length - 1 ? STAGES[stageIndex + 1] : null;

  const gates: GateInfo[] = (session.stageGateResults ?? []).map((gate) => ({
    id: gate.id,
    status: gate.status,
  }));

  // Гейты задач: внутри цикла каждая задача несёт свои вердикты, и сессионная
  // строка скрыла бы, какая именно прошла review.
  const taskGates: TaskGateInfo[] = Object.values(session.loopRuns ?? {}).map((run) => ({
    taskId: run.taskId,
    stage: run.stage,
    status: run.status,
    gates: Object.entries(run.gates ?? {}).map(([id, status]) => ({ id, status })),
    checks: run.checks,
  }));

  const retryBudgets: RetryInfo[] = Object.entries(session.retryBudgets ?? {}).map(
    ([key, budget]) => ({ key, attempts: budget.attempts, maximum: budget.maximum })
  );

  return {
    ok: true as const,
    value: {
      rootSessionID: session.sessionId,
      stage: finalStage,
      prevStage,
      nextStage,
      revision: session.revision,
      completedTasks: completedCount,
      totalTasks: tasks.length,
      activeOperations: parseActiveOperations(session.activeOperations),
      gates,
      taskGates,
      retryBudgets,
      raw: session as unknown as Record<string, unknown>,
    },
  };
}

export const SIDEBAR_WIDTH = 37;

const GATE_GLYPH: Record<string, string> = {
  pending: '⏳',
  running: '⋯',
  passed: '✓',
  failed: '✗',
  skipped: '—',
};

function gateStatusGlyph(gates: GateInfo[]): string {
  const active = gates.find((g) => g.status === 'failed' || g.status === 'running');
  if (active) return `${active.id}=${GATE_GLYPH[active.status] ?? active.status}`;
  return '';
}

export function formatSectionLines(view: Tui): string[] {
  const lines: string[] = [];

  // Верхняя строка: ▶               code               ✕
  const stageLabel = view.stage;
  const leftCtrl = '▶';
  const rightCtrl = '✕';
  const center = ` ${stageLabel} `;
  const contentWidth = leftCtrl.length + center.length + rightCtrl.length;
  const padTotal = SIDEBAR_WIDTH - contentWidth;
  const padLeft = Math.floor(padTotal / 2);
  lines.push(
    `${leftCtrl}${' '.repeat(Math.max(0, padLeft))}${center}${' '.repeat(Math.max(0, padTotal - padLeft))}${rightCtrl}`
  );

  // Строка графа фаз: ── planning ── ● code ▼ ── review → ──
  // Если не влезает в SIDEBAR_WIDTH, укорачиваем названия фаз до первых букв
  const prevStr = view.prevStage ?? '·';
  const nextStr = view.nextStage ?? '·';
  const currentStr = `● ${view.stage}`;

  let graph = `── ${prevStr} ── ${currentStr} ▼ ── ${nextStr} → ──`;
  if (graph.length > SIDEBAR_WIDTH) {
    // Сокращаем граф: убираем пробелы вокруг стрелок, короткие названия — первую букву
    const shortPrev = prevStr.length > 1 ? prevStr[0]! : prevStr;
    const shortCur = view.stage;
    const shortNext = nextStr.length > 1 ? nextStr[0]! : nextStr;
    graph = `──${shortPrev}─●${shortCur}▼──${shortNext}→──`;
  }
  if (graph.length > SIDEBAR_WIDTH) {
    graph = `${graph.slice(0, SIDEBAR_WIDTH - 1)}…`;
  }
  const graphPad = Math.max(0, SIDEBAR_WIDTH - graph.length);
  const graphLeft = Math.floor(graphPad / 2);
  lines.push(`${' '.repeat(graphLeft)}${graph}`);

  // Третья строка: gates/retry/status info
  const statusParts: string[] = [];

  // Task verdicts come first: inside a loop they are what is moving, and the
  // status line is narrow enough that whatever comes last is what gets cut.
  // task-1@verify ✓review ⏳qa — a session row would say "review passed"
  // while another task is still in code.
  for (const task of view.taskGates) {
    if (task.gates.length === 0 && !task.checks) continue;
    const verdicts = task.gates
      .map((gate) => `${GATE_GLYPH[gate.status] ?? '?'}${gate.id}`)
      .join('');
    // Вердикт движка идёт первым: он и есть причина, по которой задача не
    // ушла со стадии, когда гейтов ещё нет.
    const checks = task.checks ? `${GATE_GLYPH[task.checks] ?? '?'}checks` : '';
    statusParts.push(`${task.taskId}@${task.stage} ${checks}${verdicts}`);
  }

  // Gates: ⏳invariants  ✓test
  for (const gate of view.gates) {
    const glyph = GATE_GLYPH[gate.status] ?? '?';
    statusParts.push(`${glyph}${gate.id}`);
  }

  // Retry budgets: retry.code=1/3
  for (const rb of view.retryBudgets) {
    if (rb.maximum > 0) {
      statusParts.push(`retry.${rb.key}=${rb.attempts}/${rb.maximum}`);
    }
  }

  if (statusParts.length > 0) {
    lines.push(buildStatusLine(statusParts, SIDEBAR_WIDTH));
  } else {
    lines.push('');
  }

  return lines;
}

/**
 * Собирает строку статуса (gates + retry) с overflow-логикой:
 * влезает — отображаем всё; не влезает — показываем сколько gate/retry влезло +N more.
 * Обрезается до SIDEBAR_WIDTH, padding центрирует строку.
 */
function buildStatusLine(parts: string[], width: number): string {
  const sep = '  ';

  // Пробуем уместить все части
  const full = parts.join(sep);
  if (full.length <= width) {
    const pad = Math.max(0, width - full.length);
    const padLeft = Math.floor(pad / 2);
    return `${' '.repeat(padLeft)}${full}`;
  }

  // Не влезло — greedy fill: добавляем части пока влезают, остальные в +N
  let accumulated = '';
  let count = 0;
  for (const part of parts) {
    const candidate = accumulated.length === 0 ? part : `${accumulated}${sep}${part}`;
    if (candidate.length > width - 6) break; // резервируем место под " +N"
    accumulated = candidate;
    count++;
  }

  const remaining = parts.length - count;
  const suffix = remaining > 0 ? ` +${remaining}` : '';
  const result = `${accumulated}${suffix}`;

  // Если всё ещё не влезает — корневое обрезание
  if (result.length > width) {
    return `${result.slice(0, width - 1)}…`;
  }

  const pad = Math.max(0, width - result.length);
  const padLeft = Math.floor(pad / 2);
  return `${' '.repeat(padLeft)}${result}`;
}

// ===== Сводные поля секции (FR-011) и полный дамп диалога (FR-012) =====

const MAX_LINE = 72;
const TOP_N = 3;

function trunc(value: string, max = MAX_LINE): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '""' : trunc(value);
  if (typeof value === 'object') return trunc(JSON.stringify(value));
  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectionLines(
  label: string,
  items: readonly unknown[],
  formatItem?: (item: unknown) => string
): string[] {
  const head = `${label}: ${items.length}`;
  if (items.length === 0) return [head];
  const shown = items
    .slice(0, TOP_N)
    .map((item) => `  · ${trunc(formatItem ? formatItem(item) : scalar(item), MAX_LINE - 4)}`);
  const rest = items.length - shown.length;
  return [head, ...shown, ...(rest > 0 ? [`  +${rest} ещё`] : [])];
}

/**
 * Скалярные поля сессии, выводимые построчно и в этом порядке.
 *
 * Здесь стояли `runId`, `rootSessionID`, `currentTaskIndex` и `state` — ни
 * одного из них у схемы сессии нет, так что четыре строки из восьми всегда
 * печатали «—».
 */
const KNOWN_KEYS = [
  'sessionId',
  'profileId',
  'schemaId',
  'schemaVersion',
  'revision',
  'updatedAt',
  'title',
  'currentStage',
  'checks',
] as const;

/**
 * Полный дамп сессии для панели подробностей.
 *
 * Тоже принимает объект. Разбор текста и защита от чужих форм здесь не нужны
 * по той же причине, что и в `parseRuntimeState`: сессию уже проверила схема.
 * Вместе с текстом ушли и мёртвые чтения — `tasks` массивом, статусы `active`
 * и `committed`, которых нет среди статусов задачи, и поле `processedEventIds`,
 * которого нет у схемы.
 */
export function formatDetailsLines(session: WorkflowSession): string[] {
  const record = session as unknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of KNOWN_KEYS) {
    lines.push(`${key}: ${scalar(record[key])}`);
  }

  // По строке на открытый вызов. Читалось `activeMutation` — одиночный объект
  // и поле, которого у схемы нет, — так что не печаталось ничего.
  for (const operation of parseActiveOperations(session.activeOperations)) {
    lines.push(
      `activeOperation: callID=${scalar(operation.callId)} task=${scalar(operation.taskId)} ` +
        `agent=${scalar(operation.agent)} outputReady=${scalar(operation.outputReady)}`
    );
  }

  const tasks = Object.values(session.tasks ?? {}).flat();
  lines.push(`tasks: ${tasks.length}`);
  if (tasks.length > 0) {
    const running = tasks.filter((task) => task.status === 'running').length;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    lines.push(`  running=${running} completed=${completed}`);
  }

  const gates = session.stageGateResults ?? [];
  if (gates.length > 0) {
    lines.push(`gates: ${gates.map((gate) => `${gate.id}=${gate.status}`).join(', ')}`);
  }

  // Чем кончилось — и почему. Ради этой строки архив и существует: без неё
  // «завершилось», «провалилось» и «застряло» читаются одинаково.
  const outcome = session.outcome;
  if (outcome) {
    lines.push(`outcome: ${outcome.from} → ${outcome.stage}`);
    lines.push(`  because: ${outcome.guard ?? '(ребро без условия)'}`);
    if (outcome.failedGates.length > 0) {
      lines.push(`  failedGates: ${outcome.failedGates.join(', ')}`);
    }
    if (outcome.exhaustedBudgets.length > 0) {
      lines.push(`  exhaustedBudgets: ${outcome.exhaustedBudgets.join(', ')}`);
    }
  }

  lines.push(...collectionLines('changedFiles', session.changedFiles ?? []));

  for (const [budget, value] of Object.entries(session.retryBudgets ?? {})) {
    lines.push(`retry.${budget}: ${scalar(value.attempts)}/${scalar(value.maximum)}`);
  }

  const known = new Set<string>([
    ...KNOWN_KEYS,
    'activeOperations',
    'tasks',
    'gates',
    'outcome',
    'changedFiles',
    'retryBudgets',
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) lines.push(`${key}: ${trunc(JSON.stringify(value) ?? scalar(value))}`);
  }
  return lines;
}

// ─── Profile list formatting ─────────────────────────────────────────────────

export type ProfileSummary = { id: string; description?: string };

export function formatProfilesList(profiles: ProfileSummary[], width: number): string[] {
  if (profiles.length === 0) {
    return ['No profiles'];
  }
  const maxShow = Math.max(1, Math.floor((width - 4) / 9)); // ~9 chars per "id, " segment
  const shown = profiles.slice(0, maxShow).map((p) => p.id);
  const rest = profiles.length - shown.length;
  if (rest > 0) {
    shown.push(`+${rest}`);
  }
  return shown;
}
