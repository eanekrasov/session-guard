import { describe, it, expect } from 'vitest';

import { createSession } from '../../src/session/session-store.ts';
import {
  getGate,
  setGateStatus,
  bumpRetry,
  isExhausted,
  resetRetry,
} from '../../src/session/helpers.ts';
import { setInvariantViolations } from '../../test/helpers.ts';

describe('createSession', () => {
  it('returns a session with correct defaults', () => {
    const session = createSession('session-123', 'android');

    expect(session.sessionId).toBe('session-123');
    expect(session.profileId).toBe('android');
    expect(session.schemaVersion).toBe(2);
    expect(session.revision).toBe(0);
    expect(session.title).toBe('');
    expect(session.testStatus).toEqual({});
    expect(session.deliveryPermit).toBeNull();
    expect(session.verifications).toEqual([]);
    expect(session.currentStage).toBe('planning');
    expect(session.refs).toEqual({});
    expect(session.tasks).toEqual({});
    expect(session.approvals).toEqual([]);
    expect(session.activeOperations).toEqual({});
    expect(session.loopRuns).toEqual({});
    expect((session as Record<string, unknown>).baselineHashes).toBeUndefined();
    expect(session.changedFiles).toEqual([]);
    expect(session.updatedAt).toBeDefined();
    expect(session.preset).toBeUndefined();
  });

  it('creates CORE_GATES deep copy — 3 gates, all pending', () => {
    const session = createSession('session-123', 'android');

    expect(session.gates).toHaveLength(3);
    expect(session.gates[0]).toEqual({
      id: 'invariants',
      status: 'pending',
      label: 'Invariants check',
    });
    expect(session.gates[1]).toEqual({ id: 'review', status: 'pending', label: 'Code review' });
    expect(session.gates[2]).toEqual({ id: 'qa', status: 'pending', label: 'QA verification' });
  });

  it('creates CORE_GATES as a deep copy (mutating gates does not affect CORE_GATES)', () => {
    const session = createSession('session-123', 'android');
    session.gates[0].status = 'passed';

    // Re-create and verify the original CORE_GATES values are untouched
    const session2 = createSession('session-456', 'ios');
    expect(session2.gates[0].status).toBe('pending');
  });

  it('initializes retryBudgets without a legacy global default', () => {
    const session = createSession('session-123', 'android');

    expect(session.retryBudgets).toEqual({});
  });
});

describe('getGate', () => {
  it('returns a gate by its id', () => {
    const session = createSession('session-123', 'android');

    const gate = getGate(session, 'invariants');

    expect(gate).toBeDefined();
    expect(gate!.id).toBe('invariants');
    expect(gate!.status).toBe('pending');
  });

  it('returns undefined for unknown gate id', () => {
    const session = createSession('session-123', 'android');

    const gate = getGate(session, 'nonexistent');

    expect(gate).toBeUndefined();
  });
});

describe('setGateStatus', () => {
  it('mutates session in-place', () => {
    const session = createSession('session-123', 'android');

    setGateStatus(session, 'invariants', 'passed');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('passed');
  });

  it('sets resolvedAt when status is passed', () => {
    const session = createSession('session-123', 'android');

    setGateStatus(session, 'invariants', 'passed');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('passed');
    expect(gate!.resolvedAt).toBeDefined();
    expect(typeof gate!.resolvedAt).toBe('string');
  });

  it('sets resolvedAt when status is failed', () => {
    const session = createSession('session-123', 'android');

    setGateStatus(session, 'invariants', 'failed');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('failed');
    expect(gate!.resolvedAt).toBeDefined();
  });

  it('does NOT set resolvedAt for pending status', () => {
    const session = createSession('session-123', 'android');

    setGateStatus(session, 'invariants', 'pending');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('pending');
    expect(gate!.resolvedAt).toBeUndefined();
  });

  it('does NOT set resolvedAt for skipped status', () => {
    const session = createSession('session-123', 'android');

    setGateStatus(session, 'invariants', 'skipped');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('skipped');
    expect(gate!.resolvedAt).toBeUndefined();
  });

  it('is a no-op for unknown gate id', () => {
    const session = createSession('session-123', 'android');
    const originalGates = [...session.gates];

    setGateStatus(session, 'nonexistent', 'passed');

    expect(session.gates).toEqual(originalGates);
  });
});

describe('bumpRetry', () => {
  it('increments attempts for an existing budget key', () => {
    const session = createSession('session-123', 'android');

    bumpRetry(session, 'task-1');

    expect(session.retryBudgets['task-1'].attempts).toBe(1);
  });

  it('creates a budget key if missing with attempt=1 after bump', () => {
    const session = createSession('session-123', 'android');

    bumpRetry(session, 'task-1');

    expect(session.retryBudgets['task-1']).toBeDefined();
    expect(session.retryBudgets['task-1'].attempts).toBe(1);
    expect(session.retryBudgets['task-1'].maximum).toBe(3);
  });
});

describe('isExhausted', () => {
  it('returns false when attempts are below maximum', () => {
    const session = createSession('session-123', 'android');

    const result = isExhausted(session, 'task-1');

    expect(result).toBe(false);
  });

  it('returns true when attempts reach maximum', () => {
    const session = createSession('session-123', 'android');
    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');

    const result = isExhausted(session, 'task-1');

    expect(result).toBe(true);
  });

  it('returns false for unknown key', () => {
    const session = createSession('session-123', 'android');

    const result = isExhausted(session, 'nonexistent');

    expect(result).toBe(false);
  });
});

describe('resetRetry', () => {
  it('resets attempts to 0 for an existing key', () => {
    const session = createSession('session-123', 'android');
    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');

    resetRetry(session, 'task-1');

    expect(session.retryBudgets['task-1'].attempts).toBe(0);
    expect(session.retryBudgets['task-1'].maximum).toBe(3);
  });

  it('creates a default budget key if missing', () => {
    const session = createSession('session-123', 'android');

    resetRetry(session, 'task-1');

    expect(session.retryBudgets['task-1']).toBeDefined();
    expect(session.retryBudgets['task-1'].attempts).toBe(0);
    expect(session.retryBudgets['task-1'].maximum).toBe(3);
  });
});

describe('setInvariantViolations', () => {
  it('replaces violations with sequentially assigned evidence IDs', () => {
    const session = createSession('session-123', 'android');

    setInvariantViolations(session, [
      { severity: 'critical', message: 'Violation 1', status: 'open' },
      { severity: 'warning', message: 'Violation 2', status: 'open' },
      { severity: 'info', message: 'Violation 3', status: 'resolved' },
    ]);

    expect(session.invariantViolations).toHaveLength(3);
    expect(session.invariantViolations[0]).toEqual({
      evidenceId: 'iv-1',
      severity: 'critical',
      message: 'Violation 1',
      status: 'open',
    });
    expect(session.invariantViolations[1]).toEqual({
      evidenceId: 'iv-2',
      severity: 'warning',
      message: 'Violation 2',
      status: 'open',
    });
    expect(session.invariantViolations[2]).toEqual({
      evidenceId: 'iv-3',
      severity: 'info',
      message: 'Violation 3',
      status: 'resolved',
    });
  });

  it('clears previous invariant violations when setting new ones', () => {
    const session = createSession('session-123', 'android');
    setInvariantViolations(session, [{ severity: 'critical', message: 'Old', status: 'open' }]);

    setInvariantViolations(session, [{ severity: 'info', message: 'New', status: 'resolved' }]);

    expect(session.invariantViolations).toHaveLength(1);
    expect(session.invariantViolations[0].evidenceId).toBe('iv-1');
    expect(session.invariantViolations[0].message).toBe('New');
  });
});
