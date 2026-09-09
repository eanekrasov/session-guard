import { describe, it, expect } from 'vitest';

// RED: Reference production code that does NOT exist yet
import {
  WorkflowSessionSchema,
  ApprovalSchema,
  GateSchema,
  MutationTaskSchema,
  ActiveOperationSchema,
} from '../../src/session/session-schema.ts';

describe('WorkflowSessionSchema', () => {
  it('validates a valid session with sessionId and profileId', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
      schemaId: 'session-guard',
    };

    const result = WorkflowSessionSchema.parse(input);

    expect(result.sessionId).toBe('session-123');
    expect(result.profileId).toBe('android');
  });

  it('applies defaults for optional fields', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
      schemaId: 'session-guard',
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
    expect(result.deliveryPermit).toBeNull();
    expect(result.verifications).toEqual([]);
    expect(result.refs).toEqual({});
    expect((result as Record<string, unknown>).baselineHashes).toBeUndefined();
    expect(result.changedFiles).toEqual([]);
    expect(result.updatedAt).toBeDefined();
    expect(result.invariantViolations).toEqual([]);
  });

  it('rejects empty sessionId', () => {
    const input = {
      sessionId: '',
      profileId: 'android',
      schemaId: 'session-guard',
    };

    expect(() => WorkflowSessionSchema.parse(input)).toThrow();
  });

  it('rejects empty profileId', () => {
    const input = {
      sessionId: 'session-123',
      profileId: '',
      schemaId: 'cycle',
    };

    expect(() => WorkflowSessionSchema.parse(input)).toThrow();
  });

  it('strips unknown fields via .strip()', () => {
    const input = {
      sessionId: 'session-123',
      profileId: 'android',
      schemaId: 'session-guard',
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
      schemaId: 'session-guard',
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
      schemaId: 'session-guard',
      retryBudgets: {
        'task-1': { attempts: 2, maximum: 5 },
      },
    };

    const result = WorkflowSessionSchema.parse(input);

    expect(result.retryBudgets['task-1']).toEqual({ attempts: 2, maximum: 5 });
  });

  it('accepts a workflow-level budget key beside a task one', () => {
    // There are two budgets, not one. `base.yaml` spends `cycles` when
    // validation sends the whole body of work back into the loop; accepting
    // only `task-N` meant that edge's own effect could never be saved.
    const result = WorkflowSessionSchema.parse({
      sessionId: 'session-123',
      profileId: 'android',
      schemaId: 'session-guard',
      retryBudgets: {
        cycles: { attempts: 0, maximum: 3 },
        'task-1': { attempts: 1, maximum: 3 },
      },
    });

    expect(result.retryBudgets['cycles']).toEqual({ attempts: 0, maximum: 3 });
    expect(result.retryBudgets['task-1']).toEqual({ attempts: 1, maximum: 3 });
  });

  it('rejects a budget key that is neither a task id nor a budget name', () => {
    expect(() =>
      WorkflowSessionSchema.parse({
        sessionId: 'session-123',
        profileId: 'android',
        schemaId: 'session-guard',
        retryBudgets: {
          'Not A Key': { attempts: 0, maximum: 3 },
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

describe('MutationTaskSchema', () => {
  it('accepts a task with readScope/writeScope and no path field', () => {
    const input = {
      id: 'task-1',
      status: 'pending',
      readScope: ['src/**'],
      writeScope: ['src/auth/**'],
    };

    const result = MutationTaskSchema.parse(input);

    expect(result.readScope).toEqual(['src/**']);
    expect(result.writeScope).toEqual(['src/auth/**']);
    expect((result as Record<string, unknown>).path).toBeUndefined();
  });

  it('accepts a task with neither readScope nor writeScope', () => {
    const result = MutationTaskSchema.parse({ id: 'task-1', status: 'pending' });

    expect(result.readScope).toBeUndefined();
    expect(result.writeScope).toBeUndefined();
  });

  it('strips manifest and declaredScope — no field replaces them', () => {
    const result = MutationTaskSchema.parse({
      id: 'task-1',
      status: 'pending',
      manifest: ['a.ts'],
      declaredScope: 'src',
    } as unknown as Record<string, unknown>);

    expect((result as Record<string, unknown>).manifest).toBeUndefined();
    expect((result as Record<string, unknown>).declaredScope).toBeUndefined();
  });
});

describe('ActiveOperationSchema', () => {
  it('accepts an operation with a captured baseline frame', () => {
    const input = {
      callId: 'c1',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'coder',
      status: 'running',
      startedAt: '2024-01-01T00:00:00.000Z',
      baseline: { 'src/a.ts': 'abc123', 'src/b.ts': null },
    };

    const result = ActiveOperationSchema.parse(input);

    expect(result.baseline).toEqual({ 'src/a.ts': 'abc123', 'src/b.ts': null });
  });

  it('accepts an operation with no baseline frame (write/edit)', () => {
    const result = ActiveOperationSchema.parse({
      callId: 'c1',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'coder',
      status: 'running',
      startedAt: '2024-01-01T00:00:00.000Z',
    });

    expect(result.baseline).toBeUndefined();
    expect((result as Record<string, unknown>).invariants).toBeUndefined();
  });
});
