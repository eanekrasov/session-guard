import { describe, it, expect } from 'vitest';

// RED: Reference production code that does NOT exist yet
import {
  WorkflowSessionSchema,
  ApprovalSchema,
  GateSchema,
  CORE_GATES,
} from '../../src/session/session-schema.ts';

describe('WorkflowSessionSchema', () => {
  it('validates a valid session with sessionId and profileId', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
    };

    const result = WorkflowSessionSchema.parse(input);

    expect(result.sessionId).toBe('session-123');
    expect(result.profileId).toBe('android');
  });

  it('applies defaults for optional fields', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
    };

    const result = WorkflowSessionSchema.parse(input);

    expect(result.schemaVersion).toBe(2);
    expect(result.revision).toBe(0);
    expect(result.title).toBe('');
    expect(result.gates).toEqual([]);
    expect(result.approvals).toEqual([]);
    expect(result.tasks).toEqual({});
    expect(result.activeOperations).toEqual({});
    expect(result.loopRuns).toEqual({});
    expect(result.testStatus).toEqual({});
    expect(result.deliveryPermit).toBeNull();
    expect(result.verifications).toEqual([]);
    expect(result.refs).toEqual({});
    expect(result.baselineHashes).toEqual([]);
    expect(result.changedFiles).toEqual([]);
    expect(result.updatedAt).toBeDefined();
    expect(result.invariantViolations).toEqual([]);
  });

  it('rejects empty sessionId', () => {
    const input = {
      sessionId: '',
      profileId: 'android',
    };

    expect(() => WorkflowSessionSchema.parse(input)).toThrow();
  });

  it('rejects empty profileId', () => {
    const input = {
      sessionId: 'session-123',
      profileId: '',
    };

    expect(() => WorkflowSessionSchema.parse(input)).toThrow();
  });

  it('strips unknown fields via .strip()', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
      unknownField: 'should be stripped',
    };

    const result = WorkflowSessionSchema.parse(input);

    expect(result.sessionId).toBe('session-123');
    expect((result as Record<string, unknown>).unknownField).toBeUndefined();
  });

  it('preserves unknown fields via .passthrough()', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
      futureField: 'should be preserved',
    };

    const result = WorkflowSessionSchema.passthrough().parse(input);

    expect(result.sessionId).toBe('session-123');
    expect((result as Record<string, unknown>).futureField).toBe('should be preserved');
  });

  it('accepts retryBudgets keyed by a workflow task ID', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
      retryBudgets: {
        'task-1': { attempts: 2, maximum: 5 },
      },
    };

    const result = WorkflowSessionSchema.parse(input);

    expect(result.retryBudgets['task-1']).toEqual({ attempts: 2, maximum: 5 });
  });

  it('rejects retryBudgets not keyed by a workflow task ID', () => {
    expect(() =>
      WorkflowSessionSchema.parse({
        sessionId: 'session-123',
        profileId: 'android',
        retryBudgets: {
          cycles: { attempts: 0, maximum: 3 },
        },
      })
    ).toThrow();
  });
});

describe('ApprovalSchema', () => {
  it('validates a valid approval step with all standard fields', () => {
    const input = {
      type: 'plan',
      callId: 'call-1',
      status: 'granted',
    };

    const result = ApprovalSchema.parse(input);

    expect(result.type).toBe('plan');
    expect(result.callId).toBe('call-1');
    expect(result.status).toBe('granted');
  });

  it('validates with optional evidence and feedback', () => {
    const input = {
      type: 'plan',
      callId: 'call-1',
      status: 'denied',
      evidence: 'sha256:abc',
      feedback: 'Missing tests',
    };

    const result = ApprovalSchema.parse(input);

    expect(result.type).toBe('plan');
    expect(result.callId).toBe('call-1');
    expect(result.status).toBe('denied');
    expect(result.evidence).toBe('sha256:abc');
    expect(result.feedback).toBe('Missing tests');
  });

  it('validates granted with evidence but no feedback', () => {
    const input = {
      type: 'plan',
      callId: 'call-1',
      status: 'granted',
      evidence: 'sha256:abc',
    };

    const result = ApprovalSchema.parse(input);

    expect(result.type).toBe('plan');
    expect(result.callId).toBe('call-1');
    expect(result.status).toBe('granted');
    expect(result.evidence).toBe('sha256:abc');
    expect(result.feedback).toBeUndefined();
  });

  it('rejects missing type', () => {
    const input = {
      callId: 'call-1',
      status: 'pending',
    };

    expect(() => ApprovalSchema.parse(input)).toThrow();
  });

  it('rejects missing callId', () => {
    const input = {
      type: 'plan',
      status: 'pending',
    };

    expect(() => ApprovalSchema.parse(input)).toThrow();
  });

  it('rejects invalid status', () => {
    const input = {
      type: 'plan',
      callId: 'call-1',
      status: 'invalid',
    };

    expect(() => ApprovalSchema.parse(input)).toThrow();
  });

  it('rejects empty type', () => {
    const input = {
      type: '',
      callId: 'c',
      status: 'pending',
    };

    expect(() => ApprovalSchema.parse(input)).toThrow();
  });

  it('rejects empty callId', () => {
    const input = {
      type: 'plan',
      callId: '',
      status: 'pending',
    };

    expect(() => ApprovalSchema.parse(input)).toThrow();
  });
});

describe('GateSchema', () => {
  it('validates a valid gate', () => {
    const input = { id: 'invariants', status: 'pending' };

    const result = GateSchema.parse(input);

    expect(result.id).toBe('invariants');
    expect(result.status).toBe('pending');
  });

  it('rejects invalid gate status like "pass"', () => {
    const input = { id: 'invariants', status: 'pass' };

    expect(() => GateSchema.parse(input)).toThrow();
  });

  it('rejects invalid gate status like "fail"', () => {
    const input = { id: 'invariants', status: 'fail' };

    expect(() => GateSchema.parse(input)).toThrow();
  });
});

describe('CORE_GATES', () => {
  it('has 3 gates: invariants, review, qa — all pending', () => {
    expect(CORE_GATES).toHaveLength(3);
    expect(CORE_GATES[0].id).toBe('invariants');
    expect(CORE_GATES[0].status).toBe('pending');
    expect(CORE_GATES[1].id).toBe('review');
    expect(CORE_GATES[1].status).toBe('pending');
    expect(CORE_GATES[2].id).toBe('qa');
    expect(CORE_GATES[2].status).toBe('pending');
  });
});
