/**
 * dashboard-contract.ts — модуль контракта дашборда.
 *
 * Чистые функции и типы для сериализуемого представления стейт-машины
 * (фазы, переходы, гейты, профиль) для фронтенда. Без файлового IO,
 * без env-зависимостей — все данные передаются явно.
 *
 * @see docs/plan-dashboard-ai-harness.md — спецификация Фазы 1 и Фазы 4
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardState {
  id: string;
  label: string;
  description: string;
}

export interface DashboardTransition {
  from: string;
  to: string;
  kind: string;
  gate: string | null;
}

export interface DashboardGate {
  id: string;
  label: string;
}

export interface DashboardProfile {
  id: string;
  version: string;
  description?: string;
  invariants: string[];
  agents: string[];
  skills: string[];
}

export interface DashboardSchema {
  states: DashboardState[];
  transitions: DashboardTransition[];
  gates: DashboardGate[];
  profile: DashboardProfile;
}

/** SSE-событие перехода фазы. */
export interface SSESessionTransition {
  type: 'transition';
  sessionId: string;
  from: string;
  to: string;
  ts: number;
}

/** SSE-событие изменения статуса гейта. */
export interface SSESessionGate {
  type: 'gate';
  sessionId: string;
  gate: string;
  status: string;
  ts: number;
}

export type SSESessionEvent = SSESessionTransition | SSESessionGate;

// ─── Defaults ──────────────────────────────────────────────────────────────────

const GATE_LABELS: Record<string, string> = {
  invariants: 'Invariants',
  review: 'Code review',
  qa: 'QA verification',
};

/**
 * Human labels for the base workflow's stages.
 *
 * Keyed by the stage id as a profile writes it — lowercase. These keys were
 * uppercase while the only caller passed lowercase, so every description
 * resolved to '' in production while the test, which fed uppercase ids of its
 * own, stayed green.
 */
const STAGE_DESCRIPTIONS: Record<string, string> = {
  planning: 'Planning',
  tasks_ready: 'Tasks ready',
  execution: 'Execution',
  validation: 'Validation',
  commit: 'Commit',
  done: 'Done',
  failed: 'Failed',
};

// ─── Factory ───────────────────────────────────────────────────────────────────

export interface DashboardInput {
  /** Фазы стейт-машины (массив ID). */
  stages: string[];
  /** Переходы между фазами. */
  transitions: Array<{ from: string; to: string }>;
  /** Гейты (статусы не нужны — только описание). */
  gates: Array<{ id: string }>;
  /** Метаданные профиля. */
  profile: DashboardProfile;
}

/**
 * Построить полный контракт дашборда из входных данных.
 *
 * Чистая функция — без файлового IO, без env-зависимостей.
 * Все данные передаются явно через DashboardInput.
 */
export function buildDashboardSchema(input: DashboardInput): DashboardSchema {
  const states: DashboardState[] = input.stages.map((id) => ({
    id,
    label: id.replace(/_/g, ' '),
    description: STAGE_DESCRIPTIONS[id] ?? '',
  }));

  const transitions: DashboardTransition[] = input.transitions.map((t) => ({
    from: t.from,
    to: t.to,
    kind: '',
    gate: null,
  }));

  const gates: DashboardGate[] = input.gates.map((g) => ({
    id: g.id,
    label: GATE_LABELS[g.id] ?? g.id,
  }));

  return {
    states,
    transitions,
    gates,
    profile: { ...input.profile },
  };
}
