import { describe, expect, test } from 'bun:test';
import { beginMutation, finishMutation } from '../../src/domain/operation-lifecycle.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

function createSession(): WorkflowSession {
  return {
    sessionId: 'test-session',
    profileId: 'test-profile',
    schemaId: 'cycle',
    schemaVersion: 2,
    revision: 0,
    title: '',
    gates: [
      { id: 'invariants', status: 'running' },
      { id: 'review', status: 'pending' },
    ],
    approvals: [],
    refs: {},
    tasks: {
      implementation: [createTask()],
    },
    activeOperations: {},
    loopRuns: {},
    deliveryPermit: null,
    retryBudgets: {},
    updatedAt: new Date().toISOString(),
    verifications: [],
    changedFiles: [],
    invariantViolations: [],
    consentedCallIDs: [],
    pendingDecisions: [],
  };
}

// Основные passed/failed сценарии — в test/domain/workflow.test.ts.
// Здесь остаются только lifecycle-специфичные краевые случаи.
describe('finishMutation', () => {
  test('finishMutation с passed=true и отсутствующим gate invariants — не падает, activeOperation очищен', () => {
    const session = createSession();
    session.gates = session.gates.filter((g) => g.id !== 'invariants');

    beginMutation(session, 'm1', 'unknown', () => 'code');
    expect(() => finishMutation(session, true, 'm1')).not.toThrow();
    expect(session.activeOperations).toEqual({});
  });
});

/**
 * Ход вне цикла задач.
 *
 * Стадия без `loop:` — обычная стадия, на которой тоже работают. Раньше
 * `beginMutation` требовал прогон и бросал «Cannot resolve a single workflow
 * task run for mutation», так что правка на такой стадии была невозможна в
 * принципе: агент получал внутреннюю ошибку вместо отказа и уходил просить
 * оператора сделать работу руками. Это поймал host-smoke на профиле `cicd`,
 * где вся работа идёт на плоских стадиях.
 */
describe('мутация вне цикла задач', () => {
  test('ход без задач допускается и кладёт вердикт на сессию', () => {
    const session = createSession();
    session.tasks = {};

    beginMutation(session, 'call-flat', 'setup', undefined, null);

    const operation = session.activeOperations['call-flat'];
    expect(operation?.callId).toBe('call-flat');
    // Прогона нет — и привязки к нему тоже, а не выдуманная.
    expect(operation?.runId).toBeUndefined();
    expect(operation?.taskId).toBeUndefined();
    expect(Object.values(session.loopRuns)).toHaveLength(0);

    finishMutation(session, true, 'call-flat');
    expect(session.checks).toBe('passed');
    expect(session.activeOperations).toEqual({});
  });

  test('провалившийся ход вне цикла виден так же, как внутри', () => {
    const session = createSession();
    session.tasks = {};

    beginMutation(session, 'call-bad', 'setup', undefined, null);
    finishMutation(session, false, 'call-bad');

    expect(session.checks).toBe('failed');
  });

  test('новый ход снимает вердикт прошлого: правка отменяет прежние проверки', () => {
    const session = createSession();
    session.tasks = {};
    beginMutation(session, 'call-one', 'setup', undefined, null);
    finishMutation(session, true, 'call-one');
    expect(session.checks).toBe('passed');

    beginMutation(session, 'call-two', 'setup', undefined, null);
    expect(session.checks).toBeUndefined();
  });

  test('несколько задач в работе — по-прежнему отказ, а не ход без области записи', () => {
    const session = createSession();
    session.tasks = {
      implementation: [
        createTask({ id: 'task-1', status: 'running' }),
        createTask({ id: 'task-2', status: 'running' }),
      ],
    };

    expect(() => beginMutation(session, 'call-ambiguous', 'coder', undefined, null)).toThrow(
      /Cannot resolve a single workflow task run/
    );
  });

  test('два последовательных цикла: кандидаты берутся только из списка своей стадии', () => {
    const session = createSession();
    session.tasks = {
      implementation: [createTask({ id: 'task-1', status: 'completed' })],
      test_suite: [createTask({ id: 'task-2', status: 'pending' })],
    };

    // Стадия называет свой список. Без этого единственной runnable-задачей
    // оказалась бы `task-2` из ещё не начатого цикла, и ход первого цикла
    // синтезировал бы прогон по чужой задаче.
    beginMutation(session, 'call-first-loop', 'coder', () => 'code', 'implementation');

    expect(session.activeOperations['call-first-loop']?.taskId).toBeUndefined();
    expect(Object.values(session.loopRuns)).toHaveLength(0);
    expect(session.tasks.test_suite?.[0]?.status).toBe('pending');
  });
});
