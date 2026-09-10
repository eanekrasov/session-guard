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
    const session = createSession('session-123', 'android', 'session-guard');

    expect(session.sessionId).toBe('session-123');
    expect(session.profileId).toBe('android');
    expect(session.schemaVersion).toBe(2);
    expect(session.revision).toBe(0);
    expect(session.title).toBe('');
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
    expect((session as Record<string, unknown>).preset).toBeUndefined();
  });

  it('carries no gates — they are created by the first verdict about them', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    expect(session.stageGateResults).toEqual([]);
  });

  it('does not share gate state between sessions', () => {
    const session = createSession('session-123', 'android', 'session-guard');
    setGateStatus(session, 'invariants', 'passed');

    const other = createSession('session-456', 'ios', 'session-guard');
    expect(other.stageGateResults).toEqual([]);
  });

  it('initializes retryBudgets without a legacy global default', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    expect(session.retryBudgets).toEqual({});
  });
});

describe('getGate', () => {
  it('returns a gate by its id', () => {
    const session = createSession('session-123', 'android', 'session-guard');
    setGateStatus(session, 'invariants', 'pending');

    const gate = getGate(session, 'invariants');

    expect(gate).toBeDefined();
    expect(gate!.id).toBe('invariants');
    expect(gate!.status).toBe('pending');
  });

  it('returns undefined for unknown gate id', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    const gate = getGate(session, 'nonexistent');

    expect(gate).toBeUndefined();
  });
});

describe('setGateStatus', () => {
  it('mutates session in-place', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'invariants', 'passed');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('passed');
  });

  it('sets resolvedAt when status is passed', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'invariants', 'passed');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('passed');
    expect(gate!.resolvedAt).toBeDefined();
    expect(typeof gate!.resolvedAt).toBe('string');
  });

  it('sets resolvedAt when status is failed', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'invariants', 'failed');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('failed');
    expect(gate!.resolvedAt).toBeDefined();
  });

  it('does NOT set resolvedAt for pending status', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'invariants', 'pending');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('pending');
    expect(gate!.resolvedAt).toBeUndefined();
  });

  it('does NOT set resolvedAt for skipped status', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'invariants', 'skipped');

    const gate = getGate(session, 'invariants');
    expect(gate!.status).toBe('skipped');
    expect(gate!.resolvedAt).toBeUndefined();
  });

  it('creates a gate the session does not carry yet', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'deploy_done', 'passed');

    const gate = getGate(session, 'deploy_done');
    expect(gate).toBeDefined();
    expect(gate!.status).toBe('passed');
    expect(gate!.resolvedAt).toBeDefined();
  });

  it('records a second verdict on the gate it already created, not a duplicate', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, 'review', 'failed');
    setGateStatus(session, 'review', 'passed');

    expect(session.stageGateResults.filter((g) => g.id === 'review')).toHaveLength(1);
    expect(getGate(session, 'review')!.status).toBe('passed');
  });

  it('ignores an empty gate id rather than storing an unnameable gate', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    setGateStatus(session, '', 'passed');

    expect(session.stageGateResults).toEqual([]);
  });
});

describe('bumpRetry', () => {
  it('increments attempts for an existing budget key', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    bumpRetry(session, 'task-1');

    expect(session.retryBudgets['task-1'].attempts).toBe(1);
  });

  it('creates a budget key if missing with attempt=1 after bump', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    bumpRetry(session, 'task-1');

    expect(session.retryBudgets['task-1']).toBeDefined();
    expect(session.retryBudgets['task-1'].attempts).toBe(1);
    expect(session.retryBudgets['task-1'].maximum).toBe(3);
  });
});

describe('isExhausted', () => {
  it('returns false when attempts are below maximum', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    const result = isExhausted(session, 'task-1');

    expect(result).toBe(false);
  });

  it('returns true when attempts reach maximum', () => {
    const session = createSession('session-123', 'android', 'session-guard');
    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');

    const result = isExhausted(session, 'task-1');

    expect(result).toBe(true);
  });

  it('returns false for unknown key', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    const result = isExhausted(session, 'nonexistent');

    expect(result).toBe(false);
  });
});

describe('resetRetry', () => {
  it('resets attempts to 0 for an existing key', () => {
    const session = createSession('session-123', 'android', 'session-guard');
    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');

    resetRetry(session, 'task-1');

    expect(session.retryBudgets['task-1'].attempts).toBe(0);
    expect(session.retryBudgets['task-1'].maximum).toBe(3);
  });

  it('creates a default budget key if missing', () => {
    const session = createSession('session-123', 'android', 'session-guard');

    resetRetry(session, 'task-1');

    expect(session.retryBudgets['task-1']).toBeDefined();
    expect(session.retryBudgets['task-1'].attempts).toBe(0);
    expect(session.retryBudgets['task-1'].maximum).toBe(3);
  });
});

describe('setInvariantViolations', () => {
  it('replaces violations with sequentially assigned evidence IDs', () => {
    const session = createSession('session-123', 'android', 'session-guard');

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
    const session = createSession('session-123', 'android', 'session-guard');
    setInvariantViolations(session, [{ severity: 'critical', message: 'Old', status: 'open' }]);

    setInvariantViolations(session, [{ severity: 'info', message: 'New', status: 'resolved' }]);

    expect(session.invariantViolations).toHaveLength(1);
    expect(session.invariantViolations[0].evidenceId).toBe('iv-1');
    expect(session.invariantViolations[0].message).toBe('New');
  });
});
