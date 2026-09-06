import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { toSessionFacts } from '../../src/domain/session-facts.ts';
import { createTask } from '../support/task-factory.ts';

function makeSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    sessionId: 'test-session',
    profileId: 'android',
    schemaVersion: 2,
    revision: 0,
    title: 'Test',
    gates: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    loopRuns: {},
    testStatus: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    verifications: [],
    retryBudgets: {},
    updatedAt: new Date().toISOString(),
    baselineHashes: [],
    changedFiles: [],
    invariantViolations: [],
    consentedCallIDs: [],
    pendingDecisions: [],
    ...overrides,
  };
}

describe('toSessionFacts', () => {
  it('projects all fields from a fully populated session', () => {
    const session = makeSession({
      deliveryReceipt: 'abc123',
      approvals: [{ type: 'plan', callId: 'call-1', status: 'granted' }],
      gates: [
        { id: 'invariants', status: 'passed' },
        { id: 'review', status: 'pending' },
      ],
      activeOperations: {
        'call-1': {
          callId: 'call-1',
          runId: 'run-1',
          taskId: 'task-1',
          agent: 'code',
          startedAt: '2024-01-01T00:00:00.000Z',
          status: 'running',
        },
      },
      tasks: {
        implementation: [createTask({ status: 'completed' })],
      },
      testStatus: { 'test-1': 'pending' },
      verifications: [{ stage: 'bug', status: 'confirmed' }],
    });

    const facts = toSessionFacts(session);

    expect(facts.lastApproval).toEqual({
      type: 'plan',
      callId: 'call-1',
      status: 'granted',
    });
    expect(facts.approvals).toEqual([{ type: 'plan', status: 'granted' }]);
    expect(facts.tasks).toHaveLength(1);
    expect(facts.tasks[0]).toEqual(createTask({ status: 'completed' }));
    expect(facts.activeOperations).toEqual([
      {
        callId: 'call-1',
        runId: 'run-1',
        taskId: 'task-1',
        agent: 'code',
        startedAt: '2024-01-01T00:00:00.000Z',
        status: 'running',
      },
    ]);
    expect(facts.testStatus).toEqual({ 'test-1': 'pending' });
    expect(facts.verified('bug', 'confirmed')).toBe(true);
    expect(facts.gates).toEqual({ invariants: 'passed', review: 'pending' });
    expect(facts.profileId).toBe('android');
    expect(facts.revision).toBe(0);
    expect(facts.deliveryReceipt).toBe('abc123');
  });

  it('returns null lastApproval for empty approvals', () => {
    const session = makeSession({ approvals: [] });
    const facts = toSessionFacts(session);

    expect(facts.lastApproval).toBeNull();
  });

  it('keeps delivery receipt absent until delivery is recorded', () => {
    const session = makeSession();
    const facts = toSessionFacts(session);

    expect(facts.deliveryReceipt).toBeNull();
  });

  it('returns no active operations when session has none', () => {
    const session = makeSession({ activeOperations: {} });
    const facts = toSessionFacts(session);

    expect(facts.activeOperations).toEqual([]);
  });

  it('projects approvals with type and status only', () => {
    const session = makeSession({
      approvals: [
        { type: 'plan', callId: 'c1', status: 'granted' },
        { type: 'commit', callId: 'c2', status: 'pending' },
      ],
    });
    const facts = toSessionFacts(session);

    expect(facts.approvals).toEqual([
      { type: 'plan', status: 'granted' },
      { type: 'commit', status: 'pending' },
    ]);
  });

  it('returns empty approvals array when no approvals exist', () => {
    const session = makeSession({ approvals: [] });
    const facts = toSessionFacts(session);

    expect(facts.approvals).toEqual([]);
  });

  it('flattens gates array into Record<string, GateStatus>', () => {
    const session = makeSession({
      gates: [
        { id: 'a', status: 'passed' },
        { id: 'b', status: 'running' },
      ],
    });
    const facts = toSessionFacts(session);

    expect(facts.gates).toEqual({ a: 'passed', b: 'running' });
  });

  it('returns empty gates record for empty gates array', () => {
    const session = makeSession({ gates: [] });
    const facts = toSessionFacts(session);

    expect(facts.gates).toEqual({});
  });

  it('returns last approval when multiple exist', () => {
    const session = makeSession({
      approvals: [
        { type: 'plan', callId: 'c1', status: 'pending' },
        { type: 'plan', callId: 'c2', status: 'granted' },
      ],
    });
    const facts = toSessionFacts(session);

    expect(facts.lastApproval).toEqual({
      type: 'plan',
      callId: 'c2',
      status: 'granted',
    });
  });
});
