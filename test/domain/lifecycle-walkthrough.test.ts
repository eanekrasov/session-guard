/**
 * Пошаговый разбор lifecycle с дампом решения движка по каждой транзиции.
 *
 * Цель: проверить, что нормальный путь полностью проходим,
 * и задокументировать, что именно происходит на фазе planning.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { baseGates } from '../support/task-factory.ts';
import type { EngineConfig, TransitionCheck } from '../../src/domain/engine.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';
import { approve } from '../../src/domain/approvals.ts';
import { setGateStatus } from '../../src/session/helpers.ts';

// ─── YAML-схема ─────────────────────────────────────────────────────────────────

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

function createSession(): WorkflowSession {
  return {
    sessionId: 'walkthrough',
    profileId: 'base',
    schemaVersion: 1,
    revision: 0,
    title: '',
    gates: baseGates(),
    approvals: [],
    refs: {},
    tasks: { implementation: [] },
    activeOperations: {},
    testStatus: {},
    deliveryPermit: null,
    retryBudgets: {},
    updatedAt: new Date().toISOString(),
    verifications: [],
    baselineHashes: [],
    changedFiles: [],
    currentStage: 'planning',
    invariantViolations: [],
    consentedCallIDs: [],
  };
}

function createEngine(): StateMachineEngine {
  return new StateMachineEngine({
    transitions: SCHEMA_TRANSITIONS,
    actionGuards: { beginMutation: "session.approved('plan') || session.revision == 0" },
    stages: {},
  });
}

/**
 * Диагностический tryApplyTransitions: пробует применить каждую исходящую
 * транзицию, но ПЕЧАТАЕТ результат checkTransition по каждой.
 */
function tryAndLog(
  engine: StateMachineEngine,
  session: WorkflowSession,
  stage: string
): { applied: boolean; to?: string; reason?: string } {
  const outgoing = SCHEMA_TRANSITIONS.filter((t) => t.from === stage);
  console.log(`\n  ── ${stage}: ${outgoing.length} outgoing transitions ──`);

  for (const t of outgoing) {
    // Ручной checkTransition через engine
    const check: TransitionCheck = engine.checkTransition(t.from, t.to, session);

    // Дополнительно: проверка consent (это внутри tryApplyTransitions, но
    // checkTransition его не проверяет — consent влияет только на skip)
    const hasConsent =
      !t.consent ||
      session.approvals.some(
        (a) =>
          a.type === (typeof t.consent === 'string' ? t.consent : t.consent.type) &&
          a.status === 'granted'
      );

    console.log(
      `    ${t.from} → ${t.to}:` +
        ` guard=${t.guard ?? '(none)'}` +
        ` consent=${t.consent ?? '(none)'}` +
        ` hasConsent=${hasConsent}` +
        ` checkTransition.allowed=${check.allowed}` +
        (check.reason ? ` reason="${check.reason}"` : '')
    );
  }

  const result = engine.tryApplyTransitions(session);
  if (result.applied) {
    console.log(`  ✅ Applied: ${stage} → ${session.currentStage}`);
  } else {
    console.log(`  ⏳ Stuck: ${result.reason ?? 'no match'}`);
  }
  return { applied: result.applied ?? false, to: session.currentStage, reason: result.reason };
}

// ─── Тест: полный проход с диагностикой ─────────────────────────────────────────

describe('Пошаговый разбор lifecycle', () => {
  it('нормальный путь — полный проход с дампом решений', () => {
    const engine = createEngine();
    const session = createSession();

    // ── Шаг 1: Изоляция planning ───────────────────────────────────────
    console.log('\n═══ Шаг 1: Вход в planning ═══');

    // actionGuard beginMutation: session.approved('plan') || session.revision == 0
    const beginMut = engine.canPerformAction(session, 'beginMutation');
    console.log(
      `  actionGuard beginMutation: allowed=${beginMut.allowed} (reason: ${beginMut.reason ?? 'none'})`
    );
    console.log(`    revision=${session.revision}, approvals.length=${session.approvals.length}`);
    // revision == 0 → true → beginMutation разрешён с пустой сессии

    // tryApplyTransitions: 1 outgoing transition
    //   planning → tasks_ready: consent=plan → skip (hasConsent=false)
    let r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(false);
    expect(session.currentStage).toBe('planning');

    // ── Шаг 2: Planning → установка refs.plan без approve ──────────────
    console.log('\n═══ Шаг 2: Устанавливаем refs.plan, НО без approve ═══');
    session.refs.plan = '/path/to/plan.md';

    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(false); // consent:plan всё ещё не даёт
    expect(session.currentStage).toBe('planning');
    // guard "session.refs.plan != null" УЖЕ прошёл
    // но consent:plan скипает транзицию

    // ── Шаг 3: Approve plan → переход ──────────────────────────────────
    console.log('\n═══ Шаг 3: Approve plan → переход в tasks_ready ═══');
    approve(session, 'plan', 'ev-1', 'call-1');
    console.log(
      `  approvals=[{type:'${session.approvals[0]?.type}', status:'${session.approvals[0]?.status}'}]`
    );

    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(true);
    expect(session.currentStage).toBe('tasks_ready');

    // ── Шаг 4: tasks_ready ─────────────────────────────────────────────
    console.log('\n═══ Шаг 4: tasks_ready — без tasks ═══');
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(false);
    // guard: hasPendingTasks() → false → stuck

    // ── Шаг 5: tasks_ready → code ──────────────────────────────────────
    console.log('\n═══ Шаг 5: Добавляем pending-таску → переход в code ═══');
    session.tasks.implementation.push({
      id: 't1',
      path: 'src/',
      status: 'pending',
      title: 'Feature',
    });
    console.log(
      `  tasks.length=${session.tasks.implementation.length}, tasks[0].status=${session.tasks.implementation[0].status}`
    );

    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(true);
    expect(session.currentStage).toBe('code');

    // ── Шаг 6: code — без gate ─────────────────────────────────────────
    console.log('\n═══ Шаг 6: code — invariants pending ═══');
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(false);
    // guard: session.gates.invariants == 'passed' → false (pending)

    // ── Шаг 7: code → review ───────────────────────────────────────────
    console.log('\n═══ Шаг 7: invariants passed → переход в review ═══');
    setGateStatus(session, 'invariants', 'passed');

    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(true);
    expect(session.currentStage).toBe('review');

    // ── Шаг 8–9: review → qa → commit → done ───────────────────────────
    console.log('\n═══ Шаг 8: review → qa ═══');
    setGateStatus(session, 'review', 'passed');
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(true);
    expect(session.currentStage).toBe('qa');

    console.log('\n═══ Шаг 9: qa → commit ═══');
    setGateStatus(session, 'qa', 'passed');
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(true);
    expect(session.currentStage).toBe('commit');
    // effects: [approve: commit]
    expect(session.approvals.some((a) => a.type === 'commit' && a.status === 'granted')).toBe(true);

    console.log('\n═══ Шаг 10: commit → done ═══');
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(false); // нет deliveryReceipt
    expect(session.currentStage).toBe('commit');

    session.deliveryReceipt = 'abc123';
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(true);
    expect(session.currentStage).toBe('done');

    console.log('\n═══ Шаг 11: done — терминальная ═══');
    r = tryAndLog(engine, session, session.currentStage);
    expect(r.applied).toBe(false);
    // done: нет исходящих транзиций

    console.log('\n═══════════════════════════════════════');
    console.log('✅ Весь путь пройден: planning → done');
  });
});
