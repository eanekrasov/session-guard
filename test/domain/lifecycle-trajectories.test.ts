/**
 * Интеграционные тесты прохождения lifecycle через YAML-схему.
 *
 * Проверяют все определённые в profiles/state-machine.yaml траектории:
 *   Нормальный путь: planning → tasks_ready → code → review → qa → commit → done
 *   QA failed → code (доработка) → review → qa → commit → done
 *   QA exhausted → failed
 *
 * Каждый тест явно указывает, какие данные нужны на каждом шаге.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { baseGates } from '../support/task-factory.ts';
import type { EngineConfig } from '../../src/domain/engine.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';
import { createTask } from '../support/task-factory.ts';
import { approve } from '../../src/domain/approvals.ts';
import { setGateStatus } from '../../src/session/helpers.ts';

// ─── YAML-схема из profiles/state-machine.yaml (транзиции + actionGuards) ──────

const SCHEMA_TRANSITIONS: EngineConfig['transitions'] = [
  { from: 'planning', to: 'tasks_ready', guard: 'session.refs.plan != null', consent: 'plan' },
  { from: 'tasks_ready', to: 'code', guard: 'hasPendingTasks()' },
  { from: 'code', to: 'review', guard: "session.gates.invariants == 'passed'" },
  { from: 'review', to: 'qa', guard: "session.gates.review == 'passed'" },
  {
    from: 'qa',
    to: 'commit',
    guard: "session.gates.qa == 'passed'",
    effects: [{ approve: 'commit' }],
  },
  {
    from: 'qa',
    to: 'code',
    guard: "session.gates.qa == 'failed' && !isExhausted('cycles')",
    effects: [{ bumpRetry: 'cycles', maxAttempts: 5 }],
  },
  { from: 'qa', to: 'failed', guard: "isExhausted('cycles')" },
  { from: 'commit', to: 'done', guard: 'session.deliveryReceipt != null' },
];

const SCHEMA_ACTION_GUARDS: EngineConfig['actionGuards'] = {
  beginMutation: "session.approved('plan') || session.revision == 0",
};

// ─── Помощник: создать fresh-сессию ─────────────────────────────────────────────

function createSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    sessionId: 'lifecycle-test',
    profileId: 'base',
    schemaId: 'state-machine',
    schemaVersion: 1,
    revision: 0,
    title: 'Lifecycle test',
    gates: baseGates(),
    approvals: [],
    refs: {},
    tasks: { implementation: [] },
    activeOperations: {},
    testStatus: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    retryBudgets: {},
    updatedAt: new Date().toISOString(),
    verifications: [],
    baselineHashes: [],
    changedFiles: [],
    currentStage: 'planning',
    invariantViolations: [],
    consentedCallIDs: [],

    ...overrides,
  };
}

function createEngine(): StateMachineEngine {
  return new StateMachineEngine({
    transitions: SCHEMA_TRANSITIONS,
    actionGuards: SCHEMA_ACTION_GUARDS,
    stages: {},
  });
}

/**
 * Перевести сессию на конкретную фазу через tryApplyTransitions.
 * Бросить ошибку, если переход не удался — тест упадёт с понятным сообщением.
 */
function advanceTo(
  session: WorkflowSession,
  engine: StateMachineEngine,
  expectedStage: string
): void {
  const result = engine.tryApplyTransitions(session);
  if (!result.applied) {
    throw new Error(
      `Expected transition to '${expectedStage}', ` +
        `but tryApplyTransitions returned: allowed=${result.allowed}, ` +
        `applied=${result.applied}, reason=${result.reason ?? '(no reason)'}`
    );
  }
  if (session.currentStage !== expectedStage) {
    throw new Error(
      `Expected stage '${expectedStage}' after transition, ` +
        `got '${session.currentStage}'. Last result: ${JSON.stringify(result)}`
    );
  }
}

/**
 * Проверить, что tryApplyTransitions НЕ применяет переход (застревание).
 */
function assertStaysAt(
  session: WorkflowSession,
  engine: StateMachineEngine,
  expectedStage: string
): void {
  const currentBefore = session.currentStage;
  const result = engine.tryApplyTransitions(session);
  if (result.applied) {
    throw new Error(
      `Expected to stay at '${expectedStage}', but transition ` +
        `'${currentBefore} → ${session.currentStage}' was applied (result: ${JSON.stringify(result)})`
    );
  }
  expect(session.currentStage).toBe(expectedStage);
}

// ─── Траектория 1: Нормальный путь ──────────────────────────────────────────────

describe('Happy path: planning → tasks_ready → code → review → qa → commit → done', () => {
  it('полный normal путь', () => {
    const engine = createEngine();
    const session = createSession();

    // ── 1. planning ──────────────────────────────────────────────────
    // Данные: пустая сессия, revision=0, refs пуст, approvals пуст
    // Гуард beginMutation: session.approved('plan') || session.revision == 0
    // revision=0 → true, даже без approve
    expect(engine.canPerformAction(session, 'beginMutation').allowed).toBe(true);
    // Переход planning→tasks_ready требует:
    //   consent: plan → approval('plan') должен быть granted
    //   guard: session.refs.plan != null → refs.plan должен быть установлен
    assertStaysAt(session, engine, 'planning');

    // Устанавливаем реф на план — guard "session.refs.plan != null"
    session.refs.plan = '/path/to/plan.md';
    // Даём consent на plan через approve
    approve(session, 'plan', 'plan-approved', 'call-001');

    advanceTo(session, engine, 'tasks_ready');

    // ── 2. tasks_ready ───────────────────────────────────────────────
    // Переход tasks_ready→code требует:
    //   guard: hasPendingTasks() → хотя бы одна таска со статусом pending/running
    assertStaysAt(session, engine, 'tasks_ready');

    session.tasks.implementation.push(createTask({ title: 'Implement feature' }));

    advanceTo(session, engine, 'code');

    // ── 3. code ──────────────────────────────────────────────────────
    // Переход code→review требует:
    //   guard: session.gates.invariants == 'passed'
    assertStaysAt(session, engine, 'code');

    setGateStatus(session, 'invariants', 'passed');

    advanceTo(session, engine, 'review');

    // ── 4. review ────────────────────────────────────────────────────
    // Переход review→qa требует:
    //   guard: session.gates.review == 'passed'
    assertStaysAt(session, engine, 'review');

    setGateStatus(session, 'review', 'passed');

    advanceTo(session, engine, 'qa');

    // ── 5. qa → commit ──────────────────────────────────────────────
    // Переход qa→commit требует:
    //   guard: session.gates.qa == 'passed'
    //   effects: [approve: commit]
    assertStaysAt(session, engine, 'qa');

    setGateStatus(session, 'qa', 'passed');

    advanceTo(session, engine, 'commit');

    // Проверяем, что effects сработали — commit approved
    expect(session.approvals.some((a) => a.type === 'commit' && a.status === 'granted')).toBe(true);

    // ── 6. commit → done ────────────────────────────────────────────
    // Переход commit→done требует:
    //   guard: session.deliveryReceipt != null
    assertStaysAt(session, engine, 'commit');

    // Симулируем получение deliveryReceipt
    session.deliveryReceipt = 'abc123def';

    advanceTo(session, engine, 'done');

    // ── 7. done — терминальная фаза, исходящих переходов нет ─────────
    assertStaysAt(session, engine, 'done');
  });
});

// ─── Траектория 2: QA failed → доработка ───────────────────────────────────────

describe('QA recovery path: qa → code → review → qa → commit → done', () => {
  it('QA не прошёл, возвращаемся на code, чиним, проходим', () => {
    const engine = createEngine();
    const session = createSession();

    // Добираемся до qa (сокращённая подготовка)
    session.refs.plan = '/plan.md';
    approve(session, 'plan', 'ok', 'c1');
    advanceTo(session, engine, 'tasks_ready');
    session.tasks.implementation.push({
      id: 't1',
      status: 'pending',
      title: 'Fix bug',
    });
    advanceTo(session, engine, 'code');
    setGateStatus(session, 'invariants', 'passed');
    advanceTo(session, engine, 'review');
    setGateStatus(session, 'review', 'passed');
    advanceTo(session, engine, 'qa');

    // ── QA проваливается ────────────────────────────────────────────
    // Переход qa→code (доработка):
    //   guard: session.gates.qa == 'failed' && !isExhausted('cycles')
    //   effects: [bumpRetry: cycles, maxAttempts: 5]

    setGateStatus(session, 'qa', 'failed');

    advanceTo(session, engine, 'code');

    // Проверяем, что ретрай-бюджет cycles увеличился (attempts=1, maximum=5)
    expect(session.retryBudgets.cycles).toBeDefined();
    expect(session.retryBudgets.cycles.attempts).toBe(1);
    expect(session.retryBudgets.cycles.maximum).toBe(5);

    // ── Проходим цикл повторно ──────────────────────────────────────
    setGateStatus(session, 'invariants', 'passed');
    advanceTo(session, engine, 'review');
    setGateStatus(session, 'review', 'passed');
    advanceTo(session, engine, 'qa');

    // QA прошёл — закрываем цикл
    setGateStatus(session, 'qa', 'passed');

    advanceTo(session, engine, 'commit');

    // Проверяем, что commit approved в этой ветке
    expect(session.approvals.some((a) => a.type === 'commit' && a.status === 'granted')).toBe(true);
  });
});

// ─── Траектория 3: QA exhausted → failed ───────────────────────────────────────

describe('QA exhausted path: qa → failed', () => {
  it('после 5 неудачных QA сессия уходит в failed', () => {
    const engine = createEngine();
    const session = createSession();

    // Добираемся до qa
    session.refs.plan = '/plan.md';
    approve(session, 'plan', 'ok', 'c1');
    advanceTo(session, engine, 'tasks_ready');
    session.tasks.implementation.push({ id: 't1', status: 'pending', title: 'Fix' });
    advanceTo(session, engine, 'code');
    setGateStatus(session, 'invariants', 'passed');
    advanceTo(session, engine, 'review');
    setGateStatus(session, 'review', 'passed');
    advanceTo(session, engine, 'qa');

    // QA проваливается 5 раз — исчерпываем лимит
    // При каждом переходе qa→code срабатывает bumpRetry: cycles, увеличивая attempts
    for (let i = 0; i < 5; i++) {
      // QA failed
      setGateStatus(session, 'qa', 'failed');
      advanceTo(session, engine, 'code');

      // Возвращаемся на qa
      setGateStatus(session, 'invariants', 'passed');
      advanceTo(session, engine, 'review');
      setGateStatus(session, 'review', 'passed');
      advanceTo(session, engine, 'qa');
    }

    // Бюджет исчерпан — attempts=5, maximum=5
    expect(session.retryBudgets.cycles.attempts).toBe(5);
    expect(session.retryBudgets.cycles.maximum).toBe(5);

    // Ещё один QA failed — теперь isExhausted('cycles') == true
    // Переход qa→code блокируется (guard: ... !isExhausted('cycles'))
    // Переход qa→failed срабатывает (guard: isExhausted('cycles'))
    setGateStatus(session, 'qa', 'failed');

    advanceTo(session, engine, 'failed');

    // Терминальная фаза — исходящих переходов нет
    assertStaysAt(session, engine, 'failed');
  });
});

// ─── Траектория 4: Guard-контракты (краевые случаи) ────────────────────────────

describe('Guard contracts — каждый тип guard-выражения из YAML', () => {
  it("session.gates.invariants == 'passed'", () => {
    const engine = new StateMachineEngine({
      transitions: [
        { from: 'planning', to: 'code', guard: "session.gates.invariants == 'passed'" },
      ],
    });
    const session = createSession({ currentStage: 'planning' });

    assertStaysAt(session, engine, 'planning');

    setGateStatus(session, 'invariants', 'passed');
    advanceTo(session, engine, 'code');
  });

  it('session.refs.plan != null', () => {
    const engine = new StateMachineEngine({
      transitions: [{ from: 'planning', to: 'code', guard: 'session.refs.plan != null' }],
    });
    const session = createSession({ currentStage: 'planning' });

    assertStaysAt(session, engine, 'planning');

    session.refs.plan = '/tmp/plan.md';
    advanceTo(session, engine, 'code');
  });

  it('hasPendingTasks()', () => {
    const engine = new StateMachineEngine({
      transitions: [{ from: 'planning', to: 'code', guard: 'hasPendingTasks()' }],
    });
    const session = createSession({ currentStage: 'planning' });

    assertStaysAt(session, engine, 'planning');

    session.tasks.implementation.push({ id: 't1', status: 'pending', title: 'Do' });
    advanceTo(session, engine, 'code');
  });

  it("isExhausted('cycles')", () => {
    const engine = new StateMachineEngine({
      transitions: [{ from: 'planning', to: 'failed', guard: "isExhausted('cycles')" }],
    });
    const session = createSession({ currentStage: 'planning' });

    // Бюджета ещё нет — isExhausted возвращает false
    assertStaysAt(session, engine, 'planning');

    // Устанавливаем exhausted budget
    session.retryBudgets.cycles = { attempts: 3, maximum: 3 };
    advanceTo(session, engine, 'failed');
  });

  it('session.deliveryReceipt != null', () => {
    const engine = new StateMachineEngine({
      transitions: [{ from: 'planning', to: 'done', guard: 'session.deliveryReceipt != null' }],
    });
    const session = createSession({ currentStage: 'planning' });

    assertStaysAt(session, engine, 'planning');

    session.deliveryReceipt = 'receipt-abc';
    advanceTo(session, engine, 'done');
  });

  it("Составной guard: session.gates.qa == 'failed' && !isExhausted('cycles')", () => {
    const engine = new StateMachineEngine({
      transitions: [
        {
          from: 'planning',
          to: 'code',
          guard: "session.gates.qa == 'failed' && !isExhausted('cycles')",
        },
        { from: 'planning', to: 'failed', guard: "isExhausted('cycles')" },
      ],
    });
    const session = createSession({ currentStage: 'planning' });

    // qa pending — не failed, не срабатывает
    assertStaysAt(session, engine, 'planning');

    // qa failed, budget не исчерпан
    setGateStatus(session, 'qa', 'failed');
    advanceTo(session, engine, 'code');
  });

  it("session.approved('plan') || session.revision == 0 (actionGuard)", () => {
    const engine = new StateMachineEngine({
      actionGuards: {
        beginMutation: "session.approved('plan') || session.revision == 0",
      },
    });
    const session = createSession({ revision: 0, approvals: [] });

    // revision == 0 → true
    expect(engine.canPerformAction(session, 'beginMutation').allowed).toBe(true);

    // revision != 0, без approve → false
    session.revision = 1;
    expect(engine.canPerformAction(session, 'beginMutation')).toEqual({
      allowed: false,
      reason:
        "Action guard failed for beginMutation: session.approved('plan') || session.revision == 0",
    });

    // revision != 0, но есть approve → true
    approve(session, 'plan', 'ok', 'c1');
    expect(engine.canPerformAction(session, 'beginMutation').allowed).toBe(true);
  });
});
