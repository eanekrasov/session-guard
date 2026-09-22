import type {
  WorkflowSession,
  GateStatus,
  TaskStatus,
  Verification,
  RetryBudget,
  ActiveOperation,
} from '../session/session-schema.ts';

// ─── BaseSessionFacts — общая форма для обоих интерфейсов ────────────────────────

interface BaseSessionFacts {
  /** Имя текущей стадии (например "planning", "validation") */
  currentStage?: string;

  /** Последняя запись одобрения или null, если нет */
  lastApproval: {
    type?: string;
    callId?: string;
    status?: 'pending' | 'granted' | 'denied';
    grantedAt?: string;
    evidence?: string;
    feedback?: string;
  } | null;

  /** Записи одобрений для гард-выражений вроде `session.approved('plan')` */
  approvals: ReadonlyArray<{ type: string; status: string }>;

  /** Записи задач — плоский массив {id, status} (всегда массив из toSessionFacts) */
  tasks: ReadonlyArray<{ id: string; status: TaskStatus }>;

  /** Активные операции — плоский массив из session.activeOperations */
  activeOperations: ReadonlyArray<ActiveOperation>;

  /** Записи верификаций */
  verifications: ReadonlyArray<Verification>;

  /** Мапа гейтов — Record<string, GateStatus> */
  gates: Record<string, GateStatus>;

  /** ID профиля строкой */
  profileId: string;

  /** Номер ревизии сессии */
  revision: number;

  /** Квитанция доставки, null пока модель доставки не реализована */
  deliveryReceipt: string | null;

  /** Разрешение на доставку из модели consent */
  deliveryPermit?: WorkflowSession['deliveryPermit'];

  /** Ссылки на документы (plan, spec и т.д.) */
  refs: Record<string, string>;

  /** Бюджеты ретраев — по ключу задачи или имени бюджета */
  retryBudgets: Record<string, { attempts: number; maximum: number }>;

  /** Статус основного гарда вне лупов */
  checks?: GateStatus;

  /** Разрешить дополнительные свойства для совместимости с GuardEvaluator */
  [key: string]: unknown;
}

// ─── GuardEvaluationSession — пермиссивный для тестовых моков и частичных данных ────────

/**
 * Data-only subset для конструктора GuardEvaluator.
 *
 * Все свойства опциональны чтобы принять:
 * 1. Тестовые мок-объекты с разными формами
 * 2. Частичные данные из других источников
 *
 * GuardEvaluator внутри кастит к Record<string, unknown> и читает
 * только те свойства, которые ему нужны — поэтому отсутствующие/лишние
 * свойства безвредны.
 *
 * Note: Некоторые свойства принимают union типы (array | Record) чтобы
 * вместить разные формы моков, используемые в тестах.
 */
export interface GuardEvaluationSession {
  currentStage?: string;
  lastApproval?: BaseSessionFacts['lastApproval'];
  approvals?: BaseSessionFacts['approvals'];
  tasks?:
    | ReadonlyArray<{ id: string; status: TaskStatus }>
    | Record<string, ReadonlyArray<{ id: string; status: TaskStatus }>>
    // Test mock shapes: { implementation: {...}, release: {...} } or { id: string }[]
    | Record<string, ReadonlyArray<{ id: string; status?: string }>>
    | ReadonlyArray<{ id: string; status?: string }>;
  activeOperations?:
    ReadonlyArray<ActiveOperation> | Record<string, ActiveOperation> | Record<string, unknown>;
  verifications?: BaseSessionFacts['verifications'];
  gates?:
    | Record<string, GateStatus>
    | ReadonlyArray<{ id: string; status: GateStatus }>
    // Test mock shapes: array with string status
    | Record<string, string>
    | ReadonlyArray<{ id: string; status: string }>;
  profileId?: string;
  revision?: number;
  deliveryReceipt?: string | null;
  deliveryPermit?: WorkflowSession['deliveryPermit'];
  refs?: Record<string, string>;
  retryBudgets?: Record<string, { attempts: number; maximum: number }>;
  checks?: GateStatus;
  [key: string]: unknown;
}

// ─── SessionFacts interface ──────────────────────────────────────────────────────

/**
 * Полный интерфейс фактов сессии для гард-выражений и отображения в UI.
 * Всегда полностью заполнен toSessionFacts().
 *
 * Методы:
 *   - `verified(gate, status)` — проверить, был ли вердикт дан для гейта
 *   - `isExhausted(budgetKey)` — проверить, израсходован ли бюджет ретрая
 *   - `approved(type)` — проверить, было ли одобрение данного типа грантед
 */
export interface SessionFacts extends BaseSessionFacts {
  /** Guard-expression helper: `session.verified('bug', 'confirmed')` */
  verified(gate: string, status: 'confirmed' | 'rejected'): boolean;
  /** Guard-expression helper: `isExhausted('task-1')` */
  isExhausted(budgetKey: string): boolean;
  /** Guard-expression helper: `session.approved(type)` — для consent-проверок */
  approved(type: string): boolean;
}

// ─── Projection function ───────────────────────────────────────────────────────

/**
 * Проецировать WorkflowSession в SessionFacts — плоскую структуру данных без
 * внутреннего трекинга сессии (владение задачами, состояние лупов и т.д.).
 *
 * Результат — plain data объект, подходящий для оценки гардов и отображения в UI.
 * Методы (`verified`, `isExhausted`, `approved`) привязаны к данным, чтобы их
 * можно было вызывать напрямую на возвращённом объекте.
 */
export function toSessionFacts(session: WorkflowSession): SessionFacts {
  const tasks = session.tasks ?? {};
  const activeOperations = session.activeOperations ?? {};
  const retryBudgets = session.retryBudgets ?? {};

  const facts: BaseSessionFacts = {
    currentStage: session.currentStage,
    lastApproval:
      session.approvals.length > 0
        ? (session.approvals[session.approvals.length - 1] ?? null)
        : null,
    approvals: session.approvals.map((a) => ({ type: a.type, status: a.status })),
    tasks: Object.values(tasks)
      .flat()
      .map((task) => ({ id: task.id, status: task.status })),
    activeOperations: Object.values(activeOperations),
    verifications: session.verifications.map((v) => ({ gate: v.gate, status: v.status })),
    gates: Object.fromEntries(session.stageGateResults.map((g) => [g.id, g.status])),
    profileId: session.profileId,
    revision: session.revision,
    deliveryReceipt: session.deliveryReceipt ?? null,
    deliveryPermit: session.deliveryPermit ?? null,
    refs: { ...session.refs },
    retryBudgets,
    checks: session.checks,
  };

  return {
    ...facts,
    verified(gate: string, status: 'confirmed' | 'rejected') {
      return facts.verifications.some((v) => v.gate === gate && v.status === status);
    },
    isExhausted(budgetKey: string) {
      const budget = facts.retryBudgets[budgetKey];
      return budget ? budget.attempts >= budget.maximum : false;
    },
    approved(type: string) {
      return facts.approvals.some((a) => a.type === type && a.status === 'granted');
    },
  };
}
