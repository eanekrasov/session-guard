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
  required: boolean;
}

export interface DashboardProfile {
  id: string;
  version: string;
  description?: string;
  invariants: string[];
  mandatoryStages: string[];
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

const PHASE_DESCRIPTIONS: Record<string, string> = {
  PLANNING: 'Planning',
  TASKS_READY: 'Tasks ready',
  EXECUTION: 'Execution',
  COMMIT: 'Commit',
  DONE: 'Done',
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
  const mandatoryStageIds = new Set(input.profile.mandatoryStages);

  const states: DashboardState[] = input.stages.map((id) => ({
    id,
    label: id.replace(/_/g, ' '),
    description: PHASE_DESCRIPTIONS[id] ?? '',
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
    required: mandatoryStageIds.has(g.id),
  }));

  return {
    states,
    transitions,
    gates,
    profile: { ...input.profile },
  };
}
