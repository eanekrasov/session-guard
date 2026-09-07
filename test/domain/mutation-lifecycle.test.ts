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
    baselineHashes: [],
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
