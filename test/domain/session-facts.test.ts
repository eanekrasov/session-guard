import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { toSessionFacts } from '../../src/domain/session-facts.ts';
import { createTask } from '../support/task-factory.ts';

function makeSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  const session: WorkflowSession = {
    sessionId: 'test-session',
    profileId: 'android',
    schemaId: 'session-guard',
    schemaVersion: 2,
    revision: 0,
    title: 'Test',
    stageGateResults: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    verifications: [],
    retryBudgets: {},
    updatedAt: new Date().toISOString(),
    changedFiles: [],
    invariantViolations: [],
    consentedCallIDs: [],
    pendingDecisions: [],
    currentStage: 'planning',
    processedResultCallIDs: [],
  };
  Object.assign(session, overrides);
  return session;
}

describe('toSessionFacts', () => {
  it('projects all fields from a fully populated session', () => {
    const session = makeSession({
      deliveryReceipt: 'abc123',
      approvals: [{ type: 'plan', callId: 'call-1', status: 'granted' }],
      stageGateResults: [
        { stage: 'planning', id: 'invariants', status: 'passed' },
        { stage: 'planning', id: 'review', status: 'pending' },
      ],
      activeOperations: {
        'call-1': {
          callId: 'call-1',
          runId: 'run-1',
          taskId: 'task-1',
          agent: 'code',
          startedAt: '2024-01-01T00:00:00.000Z',
          status: 'running',
          round: 0,
          kind: 'task',
        },
      },
      tasks: {
        implementation: [createTask({ status: 'completed' })],
      },
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
        round: 0,
        kind: 'task',
      },
    ]);
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
      stageGateResults: [
        { stage: 'planning', id: 'a', status: 'passed' },
        { stage: 'planning', id: 'b', status: 'running' },
      ],
    });
    const facts = toSessionFacts(session);

    expect(facts.gates).toEqual({ a: 'passed', b: 'running' });
  });

  it('returns empty gates record for empty gates array', () => {
    const session = makeSession({ stageGateResults: [] });
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
