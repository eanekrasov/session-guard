// ─── Contract Tests: SessionSnapshot ──────────────────────────────────────────
//
// Tests the public API of SessionSnapshot and toSessionSnapshot().
// These are CONTRACT tests — they verify the public interface contract,
// not internal implementation details.

import { describe, expect, test } from 'vitest';
import { toSessionSnapshot } from '../../src/types/session-snapshot.ts';
import type { WorkflowSession, TaskStatus, GateStatus } from '../../src/types/index.ts';

describe('SessionSnapshot contract', () => {
  // ── Minimal valid session factory ───────────────────────────────────────────
  // Must satisfy WorkflowSession schema defaults.

  function makeSession(overrides?: Partial<WorkflowSession>): WorkflowSession {
    return {
      sessionId: 'ses_test_001',
      profileId: 'android',
      schemaId: 'schema-1',
      schemaVersion: 1,
      revision: 0,
      title: '',
      currentStage: 'planning',
      stageGateResults: [],
      tasks: {},
      approvals: [],
      verifications: [],
      refs: {},
      activeOperations: {},
      verdictProvenance: {},
      activeTaskContexts: [],
      loopRuns: {},
      deliveryPermit: null,
      deliveryReceipt: null,
      retryBudgets: {},
      pendingDecisions: [],
      updatedAt: '2024-01-01T00:00:00.000Z',
      changedFiles: [],
      invariantViolations: [],
      consentedCallIDs: [],
      processedResultCallIDs: [],
      ...overrides,
    };
  }

  // ── toSessionSnapshot() output shape ────────────────────────────────────────

  test('produces object with required fields', () => {
    const session = makeSession();
    const snapshot = toSessionSnapshot(session);

    expect(snapshot).toHaveProperty('sessionId');
    expect(snapshot).toHaveProperty('profileId');
    expect(snapshot).toHaveProperty('schemaId');
    expect(snapshot).toHaveProperty('schemaVersion');
    expect(snapshot).toHaveProperty('revision');
    expect(snapshot).toHaveProperty('tasks');
    expect(snapshot).toHaveProperty('activeOperations');
    expect(snapshot).toHaveProperty('gates');
    expect(snapshot).toHaveProperty('approvals');
    expect(snapshot).toHaveProperty('verifications');
    expect(snapshot).toHaveProperty('refs');
  });

  test('maps scalar fields from session', () => {
    const session = makeSession({
      sessionId: 'ses_abc123',
      profileId: 'go',
      currentStage: 'review',
      revision: 42,
      schemaId: 'schema-go-1',
      schemaVersion: 3,
    });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.sessionId).toBe('ses_abc123');
    expect(snapshot.profileId).toBe('go');
    expect(snapshot.currentStage).toBe('review');
    expect(snapshot.revision).toBe(42);
    expect(snapshot.schemaId).toBe('schema-go-1');
    expect(snapshot.schemaVersion).toBe(3);
  });

  test('flattens tasks into array with id, status, title, branch', () => {
    const session = makeSession({
      tasks: {
        'role-1': [
          { id: 'task-1', status: 'pending' as TaskStatus, title: 'Do it', branch: 'main' },
          { id: 'task-2', status: 'running' as TaskStatus },
        ],
        'role-2': [
          { id: 'task-3', status: 'completed' as TaskStatus, title: 'Done', branch: 'feat' },
        ],
      },
    });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.tasks).toHaveLength(3);
    expect(snapshot.tasks[0]).toEqual({
      id: 'task-1',
      status: 'pending',
      title: 'Do it',
      branch: 'main',
    });
    expect(snapshot.tasks[1]).toEqual({
      id: 'task-2',
      status: 'running',
      title: undefined,
      branch: undefined,
    });
    expect(snapshot.tasks[2]).toEqual({
      id: 'task-3',
      status: 'completed',
      title: 'Done',
      branch: 'feat',
    });
  });

  test('maps stageGateResults to gates record', () => {
    const session = makeSession({
      stageGateResults: [
        { stage: 'planning', id: 'gate-1', status: 'passed' as GateStatus },
        { stage: 'planning', id: 'gate-2', status: 'failed' as GateStatus },
        { stage: 'planning', id: 'gate-3', status: 'pending' as GateStatus },
      ],
    });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.gates).toEqual({
      'gate-1': 'passed',
      'gate-2': 'failed',
      'gate-3': 'pending',
    });
  });

  test('maps approvals to {type, status} pairs', () => {
    const session = makeSession({
      approvals: [
        { type: 'plan', callId: 'call-1', status: 'granted' },
        { type: 'review', callId: 'call-2', status: 'denied' },
      ],
    });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.approvals).toEqual([
      { type: 'plan', status: 'granted' },
      { type: 'review', status: 'denied' },
    ]);
  });

  test('maps verifications to {gate, status} pairs', () => {
    const session = makeSession({
      verifications: [
        { gate: 'gate-1', status: 'confirmed' },
        { gate: 'gate-2', status: 'rejected' },
      ],
    });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.verifications).toEqual([
      { gate: 'gate-1', status: 'confirmed' },
      { gate: 'gate-2', status: 'rejected' },
    ]);
  });

  test('copies refs as plain object', () => {
    const session = makeSession({ refs: { plan: '/path/to/plan.md', spec: '/path/to/spec.md' } });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.refs).toEqual({ plan: '/path/to/plan.md', spec: '/path/to/spec.md' });
    // Snapshot refs must be a new object (not reference)
    expect(snapshot.refs).not.toBe(session.refs);
  });

  test('sets deliveryReceipt to null when undefined', () => {
    const session = makeSession();
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.deliveryReceipt).toBeNull();
  });

  test('preserves deliveryReceipt when set', () => {
    const session = makeSession({ deliveryReceipt: 'sha_abc123' });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.deliveryReceipt).toBe('sha_abc123');
  });

  test('maps optional fields when present', () => {
    const session = makeSession({
      updatedAt: '2024-01-15T10:30:00.000Z',
      title: 'My Session',
      checks: 'passed' as GateStatus,
      outcome: {
        stage: 'done',
        from: 'review',
        guard: null,
        failedGates: [],
        exhaustedBudgets: [],
        recordedAt: '2024-01-15T11:00:00.000Z',
      },
    });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.updatedAt).toBe('2024-01-15T10:30:00.000Z');
    expect(snapshot.title).toBe('My Session');
    expect(snapshot.checks).toBe('passed');
    expect(snapshot.outcome).toEqual({
      stage: 'done',
      from: 'review',
      guard: null,
      failedGates: [],
      exhaustedBudgets: [],
      recordedAt: '2024-01-15T11:00:00.000Z',
    });
  });

  test('is serializable (no functions, undefined fields handled)', () => {
    const session = makeSession();
    const snapshot = toSessionSnapshot(session);

    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  test('empty tasks array when session.tasks is undefined', () => {
    const session = makeSession({ tasks: undefined });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.tasks).toEqual([]);
  });

  test('empty activeOperations when session.activeOperations is undefined', () => {
    const session = makeSession({ activeOperations: undefined });
    const snapshot = toSessionSnapshot(session);

    expect(snapshot.activeOperations).toEqual({});
  });
});
