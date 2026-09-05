import { describe, it, expect } from 'vitest';
import {
  ScopedDecisionStore,
  validateCheck,
  type ScopedDecision,
  type PolicyDefinition,
  type SubjectVersion,
} from '../../src/domain/scoped-policy.ts';
import type { CheckReport, VersionRef } from '../../src/domain/workflow-model.ts';

const testExec = { scopeId: 's1', executionId: 'e1', attemptId: 'a1' };
const testPolicy: PolicyDefinition = {
  id: 'p1',
  authority: 'human',
  allowedActors: ['user'],
  outcomes: ['approve', 'reject'],
  onInvalidated: 'failed',
  onExpired: 'failed',
};
const testSubjects: SubjectVersion[] = [
  { subject: 'task-1', version: 'v1' },
  { subject: 'task-2', version: 'v2' },
];

function createDecision(overrides: Partial<ScopedDecision> = {}): ScopedDecision {
  return {
    id: 'd1',
    execution: testExec,
    purpose: 'step',
    subjects: testSubjects,
    policy: testPolicy,
    status: 'pending',
    resolution: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ScopedDecisionStore', () => {
  it('adds and retrieves a decision', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision());
    expect(store.get('d1')).toBeDefined();
    expect(store.get('d1')!.status).toBe('pending');
  });

  it('resolves a pending decision with valid outcome and authority', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision());

    const resolved = store.resolve('d1', 'approve', 'user', 'human', 5);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.resolution!.outcome).toBe('approve');
    expect(resolved!.resolution!.revision).toBe(5);
  });

  it('rejects resolution with unknown outcome', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision());

    const resolved = store.resolve('d1', 'invalid_outcome', 'user', 'human', 5);
    expect(resolved).toBeNull();
    expect(store.get('d1')!.status).toBe('pending');
  });

  it('rejects resolution of non-pending decision', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision({ status: 'resolved' }));

    const resolved = store.resolve('d1', 'approve', 'user', 'human', 5);
    expect(resolved).toBeNull();
  });

  it('invalidates decisions on subject version change', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision());

    const changed = [{ subject: 'task-1', version: 'v2' }];
    const invalidated = store.invalidate(changed);
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].status).toBe('invalidated');
    expect(invalidated[0].resolution!.outcome).toBe('failed');
  });

  it('does not invalidate decisions with unchanged subjects', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision());

    const changed = [{ subject: 'other-task', version: 'v3' }];
    const invalidated = store.invalidate(changed);
    expect(invalidated).toHaveLength(0);
    expect(store.get('d1')!.status).toBe('pending');
  });

  it('expires old decisions', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision({ createdAt: '2024-01-01T00:00:00.000Z' }));

    const future = '2025-01-01T00:00:00.000Z';
    const expired = store.expire(future);
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe('expired');
    expect(expired[0].resolution!.outcome).toBe('failed');
  });

  it('does not expire recent decisions', () => {
    const store = new ScopedDecisionStore();
    store.add(createDecision());

    const future = '2025-01-01T00:00:00.000Z';
    const expired = store.expire(future);
    expect(expired).toHaveLength(0);
  });

  it('filters pending decisions by execution', () => {
    const store = new ScopedDecisionStore();
    store.add(
      createDecision({ id: 'd1', execution: { scopeId: 's1', executionId: 'e1', attemptId: 'a1' } })
    );
    store.add(
      createDecision({
        id: 'd2',
        execution: { scopeId: 's1', executionId: 'e1', attemptId: 'a1' },
        status: 'resolved',
      })
    );
    store.add(
      createDecision({ id: 'd3', execution: { scopeId: 's2', executionId: 'e2', attemptId: 'a2' } })
    );

    const pending = store.pending(testExec);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('d1');
  });
});

describe('validateCheck', () => {
  const checkDef = {
    id: 'c1',
    acceptedOutcomes: ['pass', 'fail'],
    acceptedAuthorities: ['assertion' as const, 'verification' as const],
    allowEmptySubjects: false,
  };
  const subjects: VersionRef[] = [
    { id: 'task-1', version: 'v1' },
    { id: 'task-2', version: 'v2' },
  ];

  it('passes valid check report', () => {
    const report: CheckReport = {
      checkId: 'c1',
      outcome: 'pass',
      subjects: [{ id: 'task-1', version: 'v1' }],
      evidence: [],
    };
    expect(validateCheck(report, checkDef, subjects).valid).toBe(true);
  });

  it('rejects check with unaccepted outcome', () => {
    const report: CheckReport = {
      checkId: 'c1',
      outcome: 'unknown',
      subjects: [{ id: 'task-1', version: 'v1' }],
      evidence: [],
    };
    const result = validateCheck(report, checkDef, subjects);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not accepted');
  });

  it('rejects check with missing subjects when required', () => {
    const report: CheckReport = {
      checkId: 'c1',
      outcome: 'pass',
      subjects: [],
      evidence: [],
    };
    const result = validateCheck(report, checkDef, subjects);
    expect(result.valid).toBe(false);
  });

  it('passes check with empty subjects when allowed', () => {
    const def = { ...checkDef, allowEmptySubjects: true };
    const report: CheckReport = {
      checkId: 'c1',
      outcome: 'pass',
      subjects: [],
      evidence: [],
    };
    expect(validateCheck(report, def, subjects).valid).toBe(true);
  });

  it('rejects check with subject not in execution subjects', () => {
    const report: CheckReport = {
      checkId: 'c1',
      outcome: 'pass',
      subjects: [{ id: 'unknown-task', version: 'v99' }],
      evidence: [],
    };
    const result = validateCheck(report, checkDef, subjects);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not in execution subjects');
  });
});
