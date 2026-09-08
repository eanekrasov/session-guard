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

export type IdleReason =
  | 'no_session'
  | 'no_file'
  | 'parse_error'
  | 'invalid_structure'
  | 'unknown_schema'
  | 'missing_session_id'
  | 'no_stage';

export const IDLE_REASONS: IdleReason[] = [
  'no_session',
  'no_file',
  'parse_error',
  'invalid_structure',
  'unknown_schema',
  'missing_session_id',
  'no_stage',
] as const;

export const IDLE_ICON: Record<IdleReason, string> = {
  no_session: '⏳',
  no_file: '⏳',
  parse_error: '✗',
  invalid_structure: '✗',
  unknown_schema: '?',
  missing_session_id: '✗',
  no_stage: '⏳',
};

export const IDLE_LABEL: Record<IdleReason, string> = {
  no_session: 'sess',
  no_file: 'file',
  parse_error: 'parse',
  invalid_structure: 'struct',
  unknown_schema: 'schema',
  missing_session_id: 'sess id',
  no_stage: 'sess',
};

export interface GateInfo {
  id: string;
  status: string;
}

/** One open call, as the sidebar needs it. */
export interface ActiveOperationInfo {
  callId: string;
  taskId: string;
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
function deriveStageFromSession(record: Record<string, unknown>): string | null {
  const currentStage = record.currentStage;
  if (typeof currentStage === 'string' && currentStage !== '') return currentStage;
  return null;
}

/**
 * The open calls, from `activeOperations`.
 *
 * This read `record.activeMutation` — a single object, and a field the session
 * schema does not have — so the sidebar's "active" line never appeared. A
 * session holds a map keyed by call id, and a verifier stage runs several
 * agents at once, so there can be more than one.
 */
function parseActiveOperations(value: unknown): ActiveOperationInfo[] {
  if (!isRecord(value)) return [];
  const operations: ActiveOperationInfo[] = [];
  for (const [callId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    operations.push({
      callId: typeof raw.callId === 'string' && raw.callId !== '' ? raw.callId : callId,
      taskId: typeof raw.taskId === 'string' ? raw.taskId : '',
      agent: typeof raw.agent === 'string' ? raw.agent : '',
      outputReady: raw.result === 'output_ready',
    });
  }
  return operations;
}

export type ParseResult = { ok: true; value: Tui } | { ok: false; reason: IdleReason };

export function parseRuntimeState(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'invalid_structure' };
  }
  const record = data as Record<string, unknown>;
  if (typeof record.schemaVersion !== 'number') {
    return { ok: false, reason: 'unknown_schema' };
  }
  const sid = (record.sessionId as string) ?? (record.rootSessionID as string) ?? '';
  if (sid === '') {
    return { ok: false, reason: 'missing_session_id' };
  }
  (record as Record<string, unknown>).sessionId = sid;
  const finalStage = deriveStageFromSession(record);
  if (finalStage === null) {
    return { ok: false, reason: 'no_stage' };
  }
  const taskLists = Array.isArray(record.tasks)
    ? [record.tasks]
    : isRecord(record.tasks)
      ? Object.values(record.tasks).filter(Array.isArray)
      : [];
  const tasks = taskLists.flat();
  const committedCount = tasks.filter(
    (t) => isRecord(t) && (t.status === 'committed' || t.status === 'completed')
  ).length;

  // Neighbours in the graph. A stage the chain does not know — a profile is
  // free to name its own — has none: `indexOf` returns -1, and -1 satisfied
  // `stageIndex < STAGES.length - 1`, so the sidebar offered STAGES[0] as the
  // next stage for every stage it did not recognise.
  const stageIndex = (STAGES as readonly string[]).indexOf(finalStage);
  const prevStage: Stage | null = stageIndex > 0 ? STAGES[stageIndex - 1] : null;
  const nextStage: Stage | null =
    stageIndex >= 0 && stageIndex < STAGES.length - 1 ? STAGES[stageIndex + 1] : null;

  // Gates из массива или объекта
  const rawGates = record.gates;
  let gates: GateInfo[] = [];
  if (Array.isArray(rawGates)) {
    gates = (rawGates as Array<Record<string, unknown>>).map((g) => ({
      id: String(g.id ?? ''),
      status: String(g.status ?? ''),
    }));
  } else if (isRecord(rawGates)) {
    gates = Object.entries(rawGates).map(([id, status]) => ({ id, status: String(status) }));
  }

  // Task gates: inside a loop each task carries its own verdicts, so a session
  // gate row would hide which task actually passed review.
  const taskGates: TaskGateInfo[] = [];
  const rawRuns = record.loopRuns;
  if (isRecord(rawRuns)) {
    for (const value of Object.values(rawRuns)) {
      if (!isRecord(value)) continue;
      const runGates = isRecord(value.gates)
        ? Object.entries(value.gates).map(([id, status]) => ({ id, status: String(status) }))
        : [];
      taskGates.push({
        taskId: String(value.taskId ?? ''),
        stage: String(value.stage ?? ''),
        status: String(value.status ?? ''),
        gates: runGates,
        checks: typeof value.checks === 'string' ? value.checks : undefined,
      });
    }
  }

  // Retry budgets
  const rawBudgets = record.retryBudgets;
  let retryBudgets: RetryInfo[] = [];
  if (isRecord(rawBudgets)) {
    retryBudgets = Object.entries(rawBudgets).map(([key, value]) => {
      if (isRecord(value)) {
        return {
          key,
          attempts: Number((value as Record<string, unknown>).attempts ?? 0),
          maximum: Number((value as Record<string, unknown>).maximum ?? 3),
        };
      }
      return { key, attempts: 0, maximum: 3 };
    });
  }

  return {
    ok: true as const,
    value: {
      rootSessionID: record.sessionId as string,
      stage: finalStage,
      prevStage,
      nextStage,
      revision: typeof record.revision === 'number' ? record.revision : 0,
      completedTasks: committedCount,
      totalTasks: tasks.length,
      activeOperations: parseActiveOperations(record.activeOperations),
      gates,
      taskGates,
      retryBudgets,
      raw: record,
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

export function formatIdleLine(reason: IdleReason): string {
  const label = ` ${IDLE_ICON[reason]} ${IDLE_LABEL[reason]} `;
  const leftCtrl = '▶';
  const rightCtrl = '✕';
  const contentWidth = leftCtrl.length + label.length + rightCtrl.length;
  const padTotal = SIDEBAR_WIDTH - contentWidth;
  const padLeft = Math.floor(padTotal / 2);
  return `${leftCtrl}${' '.repeat(Math.max(0, padLeft))}${label}${' '.repeat(Math.max(0, padTotal - padLeft))}${rightCtrl}`;
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

const KNOWN_KEYS = [
  'schemaVersion',
  'runId',
  'rootSessionID',
  'revision',
  'updatedAt',
  'title',
  'currentTaskIndex',
  'state',
] as const;

export function formatDetailsLines(rawText: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const lines: string[] = [];
  for (const key of KNOWN_KEYS) {
    const value = data[key];
    lines.push(`${key}: ${scalar(value)}`);
  }

  // One line per open call. `activeMutation` was a single object and is not a
  // field the session schema has, so this printed nothing.
  for (const operation of parseActiveOperations(data.activeOperations)) {
    lines.push(
      `activeOperation: callID=${scalar(operation.callId)} task=${scalar(operation.taskId)} ` +
        `agent=${scalar(operation.agent)} outputReady=${scalar(operation.outputReady)}`
    );
  }

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  lines.push(`tasks: ${tasks.length}`);
  if (tasks.length > 0) {
    const active = tasks.findIndex((t: Record<string, unknown>) => t.status === 'active');
    const committed = tasks.filter((t: Record<string, unknown>) => t.status === 'committed').length;
    lines.push(`  active=${active >= 0 ? active : '—'} committed=${committed}`);
  }

  const gates = Array.isArray(data.gates) ? data.gates : [];
  if (gates.length > 0) {
    lines.push(
      `gates: ${gates.map((g: Record<string, unknown>) => `${g.id}=${g.status}`).join(', ')}`
    );
  }

  if (Array.isArray(data.changedFiles)) {
    lines.push(...collectionLines('changedFiles', data.changedFiles));
  }
  if (isRecord(data.retryBudgets)) {
    for (const [budget, value] of Object.entries(data.retryBudgets)) {
      if (isRecord(value)) {
        lines.push(
          `retry.${budget}: ${scalar((value as Record<string, unknown>).attempts)}/${scalar((value as Record<string, unknown>).maximum)}`
        );
      } else {
        lines.push(`retry.${budget}: ${scalar(value)}`);
      }
    }
  }
  if (Array.isArray(data.processedEventIds)) {
    lines.push(`processedEventIds: ${(data.processedEventIds as string[]).length}`);
  }

  const known = new Set<string>([
    ...KNOWN_KEYS,
    'activeOperations',
    'tasks',
    'gates',
    'changedFiles',
    'retryBudgets',
    'processedEventIds',
    'currentTaskIndex',
  ]);
  for (const [key, value] of Object.entries(data)) {
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
