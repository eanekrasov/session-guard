import { describe, expect, test } from 'bun:test';
import { beginMutation, finishMutation } from '../../src/domain/operation-lifecycle.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

function createSession(): WorkflowSession {
  return {
    sessionId: 'test-session',
    profileId: 'test-profile',
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
      implementation: [{ id: 'task-1', path: 'src/foo.ts', status: 'pending' }],
    },
    activeOperations: {},
    loopRuns: {},
    testStatus: {},
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

describe('finishMutation', () => {
  test('finishMutation с passed=true — activeOperation очищен, gate invariants = passed', () => {
    const session = createSession();

    beginMutation(session, 'm1');
    finishMutation(session, true, 'm1');

    expect(session.activeOperations).toEqual({});
    const gate = session.gates.find((g) => g.id === 'invariants');
    expect(gate?.status).toBe('passed');
  });

  test('finishMutation с passed=false — gate invariants = failed, bumpRetry task', () => {
    const session = createSession();

    beginMutation(session, 'm1');
    finishMutation(session, false, 'm1');

    expect(session.activeOperations).toEqual({});
    const gate = session.gates.find((g) => g.id === 'invariants');
    expect(gate?.status).toBe('failed');
    expect(session.retryBudgets['task-1']?.attempts).toBe(1);
  });

  test('finishMutation с passed=true и отсутствующим gate invariants — не падает, activeOperation очищен', () => {
    const session = createSession();
    session.gates = session.gates.filter((g) => g.id !== 'invariants');

    beginMutation(session, 'm1');
    expect(() => finishMutation(session, true, 'm1')).not.toThrow();
    expect(session.activeOperations).toEqual({});
  });
});
