import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { baseGates } from '../support/task-factory.ts';
import { clearActiveMutation } from '../../src/domain/operation-lifecycle.ts';
import { markOutputReady, getExecutionProgress, canExitExecution } from '../../test/helpers.ts';
import { createTask } from '../support/task-factory.ts';

function makeSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    sessionId: 'test-session',
    profileId: 'android',
    schemaId: 'state-machine',
    schemaVersion: 2,
    revision: 0,
    title: '',
    gates: baseGates(),
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

function taskList(
  tasks: Array<{
    id: string;
    path: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  }>
): WorkflowSession['tasks'] {
  return { implementation: tasks };
}

function activeOperation(callId = 'm-1'): WorkflowSession['activeOperations'] {
  return {
    [callId]: {
      callId,
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'code',
      startedAt: '2024-01-01T00:00:00.000Z',
      status: 'running',
    },
  };
}

// ─── R7.1: markOutputReady ────────────────────────────────────────────────────

describe('markOutputReady', () => {
  it('sets result to output_ready when id matches', () => {
    const session = makeSession({
      activeOperations: activeOperation('m-1'),
    });

    markOutputReady('m-1', session);

    expect(session.activeOperations['m-1'].result).toBe('output_ready');
  });

  it('is no-op when id does not match', () => {
    const session = makeSession({
      activeOperations: activeOperation('m-1'),
    });

    markOutputReady('different-id', session);

    expect(session.activeOperations['m-1'].result).toBeUndefined();
  });

  it('is no-op when no active operation exists', () => {
    const session = makeSession({ activeOperations: {} });

    expect(() => markOutputReady('m-1', session)).not.toThrow();
  });
});

// ─── R7.2: clearActiveMutation ────────────────────────────────────────────────

describe('clearActiveMutation', () => {
  it('clears the active operation', () => {
    const session = makeSession({
      activeOperations: activeOperation('m-1'),
    });

    clearActiveMutation(session);

    expect(session.activeOperations).toEqual({});
  });

  it('is safe no-op when already null', () => {
    const session = makeSession({ activeOperations: {} });

    expect(() => clearActiveMutation(session)).not.toThrow();
    expect(session.activeOperations).toEqual({});
  });
});

// ─── R7.3: getExecutionProgress ───────────────────────────────────────────────

describe('getExecutionProgress', () => {
  it('returns correct counts for mixed tasks', () => {
    const session = makeSession({
      tasks: taskList([
        createTask({ status: 'completed' }),
        createTask({ id: 'task-2', status: 'running' }),
      ]),
      activeOperations: activeOperation('m-1'),
    });

    const progress = getExecutionProgress(session);

    expect(progress).toEqual({ completed: 1, total: 2, active: 1 });
  });

  it('returns all done state', () => {
    const session = makeSession({
      tasks: taskList([createTask({ status: 'completed' })]),
      activeOperations: {},
    });

    const progress = getExecutionProgress(session);

    expect(progress).toEqual({ completed: 1, total: 1, active: 0 });
  });

  it('returns active flag when operation exists', () => {
    const session = makeSession({
      tasks: {},
      activeOperations: activeOperation('m-1'),
    });

    const progress = getExecutionProgress(session);

    expect(progress).toEqual({ completed: 0, total: 0, active: 1 });
  });
});

// ─── R7.4: canExitExecution ───────────────────────────────────────────────────

describe('canExitExecution', () => {
  it('returns true when no active operation and all tasks completed', () => {
    const session = makeSession({
      activeOperations: {},
      tasks: taskList([createTask({ status: 'completed' })]),
    });

    expect(canExitExecution(session)).toBe(true);
  });

  it('returns false when active operation exists', () => {
    const session = makeSession({
      activeOperations: activeOperation('m-1'),
      tasks: taskList([createTask({ status: 'completed' })]),
    });

    expect(canExitExecution(session)).toBe(false);
  });

  it('returns false when tasks are not all completed', () => {
    const session = makeSession({
      activeOperations: {},
      tasks: taskList([createTask({ status: 'running' })]),
    });

    expect(canExitExecution(session)).toBe(false);
  });
});
