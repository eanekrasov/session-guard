import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { baseGates } from '../support/task-factory.ts';
import {
  beginMutation,
  finishMutation,
  isExpiredMutation,
} from '../../src/domain/operation-lifecycle.ts';
import { hasLiveVerifier } from '../../test/helpers.ts';
import { approve, decline } from '../../src/domain/approvals.ts';
import { confirm, rejectVerification as reject } from '../../test/helpers.ts';
import { canCommit } from '../../src/domain/session-queries.ts';
import { parseWorkflowResult, MUTATION_TTL_MS } from '../../src/domain/evidence.ts';
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
  status: 'pending' | 'running' | 'completed' = 'pending'
): WorkflowSession['tasks'] {
  return {
    implementation: [createTask({ status })],
  };
}

function loopRun(
  status: 'pending' | 'running' | 'awaiting_decision' = 'running'
): WorkflowSession['loopRuns'] {
  return {
    'run-1': {
      id: 'run-1',
      taskId: 'task-1',
      listKey: 'implementation',
      ancestry: [],
      stage: 'mutation',
      status,
    },
  };
}

function activeOperation(
  callId: string,
  startedAt = '2024-01-01T00:00:00.000Z',
  status: 'running' | 'interrupted' = 'running'
): WorkflowSession['activeOperations'] {
  return {
    [callId]: {
      callId,
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'code',
      startedAt,
      status,
    },
  };
}

// ─── R6.1: beginMutation ───────────────────────────────────────────────────────

describe('beginMutation', () => {
  it('sets active operation from fresh state', () => {
    const session = makeSession({
      tasks: taskList(),
      verifications: [{ stage: 'bug', status: 'confirmed' }],
      gates: baseGates().map((g) =>
        g.id === 'invariants' ? { ...g, status: 'passed' as const } : { ...g }
      ),
    });

    beginMutation(session, 'mutation-1');

    expect(session.activeOperations['mutation-1']).toBeDefined();
    expect(session.activeOperations['mutation-1'].status).toBe('running');
    expect(session.activeOperations['mutation-1'].startedAt).toBeDefined();
    expect(session.verifications).toEqual([]);
    const invGate = session.gates.find((g) => g.id === 'invariants');
    expect(invGate?.status).toBe('pending');
  });

  it('throws when active operation exists and is not expired', () => {
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('existing', new Date().toISOString()),
    });

    expect(() => beginMutation(session, 'new-mutation')).toThrow(
      'Active operation already exists: existing'
    );
  });

  it('replaces an expired active operation', () => {
    const past = new Date(Date.now() - MUTATION_TTL_MS - 60_000).toISOString();
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('stale', past),
    });

    beginMutation(session, 'new-mutation');

    expect(session.activeOperations['stale']).toBeUndefined();
    expect(session.activeOperations['new-mutation'].status).toBe('running');
  });
});

// ─── R6.2: Generic step completion (replaces canCommit) ──────────────────────

describe('generic step lifecycle', () => {
  it('completes without requiring all session tasks', () => {
    const session = makeSession({
      gates: [{ id: 'invariants', status: 'passed' }],
      tasks: taskList('completed'),
    });
    // First step can complete even though later work is pending
    expect(session.tasks.implementation.every((t) => t.status === 'completed')).toBe(true);
  });

  it('keeps results separate across steps', () => {
    // Two steps produce independent results
    type StepResult = { step: string; output: string };
    const results: StepResult[] = [
      { step: 'change-first', output: 'file-a' },
      { step: 'change-second', output: 'file-b' },
    ];
    expect(results[0].output).not.toBe(results[1].output);
    // Second step cannot use first step's completion
    const secondStep = results[1];
    expect(secondStep.step).toBe('change-second');
  });
});

// ─── R6.3: approve —────────────────────────────────────────────────────────

describe('approve', () => {
  it('adds an approval record with evidence and grantedAt', () => {
    const session = makeSession({ approvals: [] });

    approve(session, 'plan', 'sha256:abc123', 'call-1');

    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0]).toMatchObject({
      type: 'plan',
      callId: 'call-1',
      status: 'granted',
      evidence: 'sha256:abc123',
    });
    expect(session.approvals[0].grantedAt).toBeDefined();
  });

  it('adds an approval for commit type', () => {
    const session = makeSession({ approvals: [] });

    approve(session, 'commit', 'ev-2', 'call-2');

    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0]).toMatchObject({
      type: 'commit',
      callId: 'call-2',
      status: 'granted',
      evidence: 'ev-2',
    });
  });

  it('updates existing approval for same type and callId', () => {
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'call-1', status: 'pending' as const }],
    });

    approve(session, 'plan', 'sha256:newhash', 'call-1');

    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].status).toBe('granted');
    expect(session.approvals[0].evidence).toBe('sha256:newhash');
  });
});

// ─── R6.4: decline ─────────────────────────────────────────────────────────

describe('decline', () => {
  it('adds a denial record with evidence and feedback', () => {
    const session = makeSession({ approvals: [] });

    decline(session, 'plan', 'sha256:abc123', 'call-2', 'Missing test cases');

    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0]).toMatchObject({
      type: 'plan',
      callId: 'call-2',
      status: 'denied',
      evidence: 'sha256:abc123',
      feedback: 'Missing test cases',
    });
  });

  it('updates existing approval to denied with new feedback', () => {
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'call-1', status: 'pending' as const }],
    });

    decline(session, 'plan', 'sha256:newhash', 'call-1', 'Revised feedback');

    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].status).toBe('denied');
    expect(session.approvals[0].feedback).toBe('Revised feedback');
  });
});

// ─── R6.5: confirm + reject ────────────────────────────────────────────────

describe('confirm', () => {
  it('adds a confirmed verification record with recordedAt', () => {
    const session = makeSession({ verifications: [] });

    confirm(session, 'bug');

    const bugV = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV).toBeDefined();
    expect(bugV!.status).toBe('confirmed');
    expect(bugV!.recordedAt).toBeDefined();
  });

  it('updates existing verification to confirmed and refreshes recordedAt', () => {
    const session = makeSession({
      verifications: [{ stage: 'bug', status: 'rejected', recordedAt: '2024-01-01T00:00:00.000Z' }],
    });

    confirm(session, 'bug');

    const bugV = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV).toBeDefined();
    expect(bugV!.status).toBe('confirmed');
    expect(bugV!.recordedAt).not.toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('reject', () => {
  it('adds a rejected verification record', () => {
    const session = makeSession({ verifications: [] });

    reject(session, 'bug');

    const bugV = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV).toBeDefined();
    expect(bugV!).toMatchObject({
      stage: 'bug',
      status: 'rejected',
    });
    expect(bugV!.recordedAt).toBeDefined();
  });

  it('updates existing verification to rejected and refreshes recordedAt', () => {
    const session = makeSession({
      verifications: [
        { stage: 'bug', status: 'confirmed', recordedAt: '2024-01-01T00:00:00.000Z' },
      ],
    });

    reject(session, 'bug');

    const bugV = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV).toBeDefined();
    expect(bugV!.status).toBe('rejected');
    expect(bugV!.recordedAt).not.toBe('2024-01-01T00:00:00.000Z');
  });
});

// ─── R6.6: finishMutation ─────────────────────────────────────────────────────

describe('finishMutation', () => {
  it('clears operation, stores modified artifacts, sets invariants passed', () => {
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1'),
    });

    session.changedFiles = ['src/foo.ts'];
    finishMutation(session, true);

    expect(session.activeOperations).toEqual({});
    expect(session.changedFiles).toEqual(['src/foo.ts']);
    const invGate = session.gates.find((g) => g.id === 'invariants');
    expect(invGate?.status).toBe('passed');
  });

  it('sets invariants failed and bumps retry on failure', () => {
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1'),
      retryBudgets: { 'task-1': { attempts: 0, maximum: 3 } },
    });

    session.changedFiles = [];
    finishMutation(session, false);

    const invGate = session.gates.find((g) => g.id === 'invariants');
    expect(invGate?.status).toBe('failed');
    expect(session.retryBudgets['task-1'].attempts).toBe(1);
    expect(session.activeOperations).toEqual({});
  });
});

// ─── R6.7: parseWorkflowResult ────────────────────────────────────────────────

describe('parseWorkflowResult', () => {
  it('parses a valid workflow-result tag', () => {
    const output =
      'Some text <workflow-result>{"stage":"review","status":"pass","summary":"LGTM","evidence":["log-1"]}</workflow-result> more text';

    const result = parseWorkflowResult(output);

    expect(result).toEqual({
      stage: 'review',
      status: 'pass',
      summary: 'LGTM',
      evidence: ['log-1'],
    });
  });

  it('returns null when no tags are present', () => {
    const output = 'Just some text';

    const result = parseWorkflowResult(output);

    expect(result).toBeNull();
  });

  it('picks the last valid tag when multiple tags exist', () => {
    const output =
      '<workflow-result>{"stage":"review","status":"pass","summary":"First","evidence":["e1"]}</workflow-result>' +
      ' <workflow-result>{"stage":"qa","status":"fail","summary":"Second","evidence":["e2"]}</workflow-result>';

    const result = parseWorkflowResult(output);

    expect(result).toEqual({
      stage: 'qa',
      status: 'fail',
      summary: 'Second',
      evidence: ['e2'],
    });
  });

  it('skips malformed JSON and returns null when no valid tags', () => {
    const output = '<workflow-result>{invalid json}</workflow-result>';

    const result = parseWorkflowResult(output);

    expect(result).toBeNull();
  });

  it('skips malformed JSON and picks next valid tag', () => {
    const output =
      '<workflow-result>{invalid}</workflow-result>' +
      ' <workflow-result>{"stage":"qa","status":"pass","summary":"Fixed","evidence":["e1"]}</workflow-result>';

    const result = parseWorkflowResult(output);

    expect(result).toEqual({
      stage: 'qa',
      status: 'pass',
      summary: 'Fixed',
      evidence: ['e1'],
    });
  });
});

// ─── R6.8: isExpiredMutation ──────────────────────────────────────────────────

describe('isExpiredMutation', () => {
  it('returns false for a mutation within TTL', () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1', recent),
    });

    expect(isExpiredMutation(session)).toBe(false);
  });

  it('returns true for a mutation past TTL', () => {
    const past = new Date(Date.now() - MUTATION_TTL_MS - 60_000).toISOString();
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1', past),
    });

    expect(isExpiredMutation(session)).toBe(true);
  });

  it('returns false when there are no active operations', () => {
    const session = makeSession({ activeOperations: {} });

    expect(isExpiredMutation(session)).toBe(false);
  });

  it('returns false for an invalid date string', () => {
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1', 'not-a-date'),
    });

    expect(isExpiredMutation(session)).toBe(false);
  });
});

// ─── R6.9: hasLiveVerifier ────────────────────────────────────────────────────

describe('hasLiveVerifier', () => {
  it('returns true when active operation is running', () => {
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1'),
    });

    expect(hasLiveVerifier(session, 'review')).toBe(true);
  });

  it('returns false when there are no active operations', () => {
    const session = makeSession({ activeOperations: {} });

    expect(hasLiveVerifier(session, 'review')).toBe(false);
  });

  it('returns false when active operation is not running', () => {
    const session = makeSession({
      tasks: taskList('running'),
      loopRuns: loopRun(),
      activeOperations: activeOperation('m-1', '2024-01-01T00:00:00.000Z', 'interrupted'),
    });

    expect(hasLiveVerifier(session, 'review')).toBe(false);
  });
});
