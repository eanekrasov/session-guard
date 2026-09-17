import { describe, it, expect, beforeEach } from 'vitest';
import type {
  WorkflowSession,
  ActiveOperation,
  LoopRun,
} from '../../src/session/session-schema.ts';
import {
  beginMutation,
  finishMutation,
  isExpiredMutation,
  clearActiveMutation,
} from '../../src/domain/operation-lifecycle.ts';
import { MUTATION_TTL_MS } from '../../src/domain/evidence.ts';

function createTestSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  const base: WorkflowSession = {
    sessionId: 'test-session',
    profileId: 'test-profile',
    schemaId: 'test-schema',
    schemaVersion: 1,
    revision: 0,
    title: 'Test Session',
    stageGateResults: [],
    approvals: [],
    refs: {},
    tasks: {
      tasks: [{ id: 'task-1', status: 'pending', writeScope: ['src/**'] }],
    },
    activeOperations: {},
    verdictProvenance: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryPermit: null,
    deliveryReceipt: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    changedFiles: [],
    currentStage: 'executing',
    invariantViolations: [],
    consentedCallIDs: [],
    processedResultCallIDs: [],
    ...overrides,
  };
  return base;
}

function createMockRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    listKey: 'tasks',
    ancestry: [],
    stage: 'executing',
    status: 'running',
    gates: {},
    round: 0,
    ...overrides,
  };
}

describe('operation-lifecycle', () => {
  let session: WorkflowSession;

  beforeEach(() => {
    session = createTestSession();
  });

  describe('beginMutation', () => {
    it('creates a new mutation operation when no active operation exists', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      expect(session.activeOperations['call-1']).toBeDefined();
      expect(session.activeOperations['call-1'].callId).toBe('call-1');
      expect(session.activeOperations['call-1'].agent).toBe('agent-1');
      expect(session.activeOperations['call-1'].kind).toBe('mutation');
      expect(session.activeOperations['call-1'].status).toBe('running');
      expect(session.activeOperations['call-1'].runId).toBeDefined();
      expect(session.activeOperations['call-1'].taskId).toBeDefined();
      expect(session.verifications).toEqual([]);
      expect(session.checks).toBeUndefined();
    });

    it('throws when an active non-expired mutation already exists', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      expect(() => beginMutation(session, 'call-2', 'agent-2', resolveStage, 'tasks')).toThrow(
        'Active operation already exists: call-1'
      );
    });

    it('allows new mutation when existing one is expired', () => {
      const oldTime = new Date(Date.now() - MUTATION_TTL_MS - 1000).toISOString();
      session.activeOperations = {
        'old-call': {
          callId: 'old-call',
          agent: 'old-agent',
          kind: 'mutation',
          startedAt: oldTime,
          status: 'running',
          round: 0,
        },
      };

      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      expect(session.activeOperations['call-1']).toBeDefined();
      expect(session.activeOperations['old-call']).toBeUndefined();
    });

    it('allows mutation when active operation is a task (kind === "task")', () => {
      session.activeOperations = {
        'task-call': {
          callId: 'task-call',
          agent: 'task-agent',
          kind: 'task',
          startedAt: new Date().toISOString(),
          status: 'running',
          round: 0,
        },
      };

      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      expect(session.activeOperations['call-1']).toBeDefined();
      expect(session.activeOperations['task-call']).toBeDefined();
    });

    it('uses provided now timestamp', () => {
      const fixedTime = '2024-01-01T00:00:00.000Z';
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks', fixedTime);

      expect(session.activeOperations['call-1'].startedAt).toBe(fixedTime);
    });

    it('expires an existing operation against the injected now, not the wall clock', () => {
      const startedAt = '2024-01-01T00:00:00.000Z';
      session.activeOperations = {
        'old-call': {
          callId: 'old-call',
          agent: 'old-agent',
          kind: 'mutation',
          startedAt,
          status: 'running',
          round: 0,
        },
      };

      const resolveStage = () => 'executing';
      const afterTtl = new Date(Date.parse(startedAt) + MUTATION_TTL_MS + 1000).toISOString();
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks', afterTtl);

      expect(session.activeOperations['old-call']).toBeUndefined();
      expect(session.activeOperations['call-1']).toBeDefined();
    });

    it('keeps an existing operation when the injected now is within TTL', () => {
      const startedAt = '2024-01-01T00:00:00.000Z';
      session.activeOperations = {
        'old-call': {
          callId: 'old-call',
          agent: 'old-agent',
          kind: 'mutation',
          startedAt,
          status: 'running',
          round: 0,
        },
      };

      const resolveStage = () => 'executing';
      const withinTtl = new Date(Date.parse(startedAt) + 1000).toISOString();

      expect(() =>
        beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks', withinTtl)
      ).toThrow('Active operation already exists: old-call');
    });

    it('clears verifications and checks on new mutation', () => {
      session.verifications = [{ gate: 'old-gate', status: 'confirmed' }];
      session.checks = 'passed' as
        'passed' | 'failed' | 'pending' | 'running' | 'skipped' | undefined;

      const resolveStage = () => 'executing';
      // Use null currentListKey with no runnable tasks to trigger checks clearing
      session.tasks = { tasks: [] };
      beginMutation(session, 'call-1', 'agent-1', resolveStage, null);

      expect(session.verifications).toEqual([]);
      expect(session.checks).toBeUndefined();
    });

    it('clears run gates when run exists', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      expect(session.loopRuns[session.activeOperations['call-1'].runId!].gates).toEqual({});
    });

    it('clears session.checks when no run is created', () => {
      session.checks = 'passed';
      const resolveStage = () => 'executing';
      // No tasks = no run created
      session.tasks = { tasks: [] };
      beginMutation(session, 'call-1', 'agent-1', resolveStage, null);

      expect(session.checks).toBeUndefined();
    });
  });

  describe('finishMutation', () => {
    it('records passed verdict on run when run exists', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');
      const runId = session.activeOperations['call-1'].runId!;

      finishMutation(session, true, 'call-1');

      expect(session.loopRuns[runId].checks).toBe('passed');
      expect(session.activeOperations['call-1']).toBeUndefined();
    });

    it('records failed verdict on run when run exists', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');
      const runId = session.activeOperations['call-1'].runId!;

      finishMutation(session, false, 'call-1');

      expect(session.loopRuns[runId].checks).toBe('failed');
      expect(session.activeOperations['call-1']).toBeUndefined();
    });

    it('records verdict on session.checks when no run exists', () => {
      const resolveStage = () => 'executing';
      // No tasks = no run created
      session.tasks = { tasks: [] };
      beginMutation(session, 'call-1', 'agent-1', resolveStage, null);

      finishMutation(session, true, 'call-1');

      expect(session.checks).toBe('passed');
      expect(session.activeOperations['call-1']).toBeUndefined();
    });

    it('uses callId from operation when not provided', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      finishMutation(session, true);

      expect(session.activeOperations['call-1']).toBeUndefined();
    });

    it('is no-op when operation does not exist', () => {
      finishMutation(session, true, 'non-existent');

      expect(session.checks).toBeUndefined();
      expect(session.activeOperations['non-existent']).toBeUndefined();
    });
  });

  describe('isExpiredMutation', () => {
    it('returns false when no active operation', () => {
      expect(isExpiredMutation(session)).toBe(false);
    });

    it('returns false when operation started recently', () => {
      session.activeOperations = {
        'call-1': {
          callId: 'call-1',
          agent: 'agent-1',
          kind: 'mutation',
          startedAt: new Date().toISOString(),
          status: 'running',
          round: 0,
        },
      };

      expect(isExpiredMutation(session)).toBe(false);
    });

    it('returns true when operation exceeded TTL', () => {
      const oldTime = new Date(Date.now() - MUTATION_TTL_MS - 1000).toISOString();
      session.activeOperations = {
        'call-1': {
          callId: 'call-1',
          agent: 'agent-1',
          kind: 'mutation',
          startedAt: oldTime,
          status: 'running',
          round: 0,
        },
      };

      expect(isExpiredMutation(session)).toBe(true);
    });

    it('returns false when startedAt is invalid', () => {
      session.activeOperations = {
        'call-1': {
          callId: 'call-1',
          agent: 'agent-1',
          kind: 'mutation',
          startedAt: 'invalid-date',
          status: 'running',
          round: 0,
        },
      };

      expect(isExpiredMutation(session)).toBe(false);
    });

    it('checks specific callId when provided', () => {
      const oldTime = new Date(Date.now() - MUTATION_TTL_MS - 1000).toISOString();
      const newTime = new Date().toISOString();
      session.activeOperations = {
        'old-call': {
          callId: 'old-call',
          agent: 'agent-1',
          kind: 'mutation',
          startedAt: oldTime,
          status: 'running',
          round: 0,
        },
        'new-call': {
          callId: 'new-call',
          agent: 'agent-1',
          kind: 'mutation',
          startedAt: newTime,
          status: 'running',
          round: 0,
        },
      };

      expect(isExpiredMutation(session, 'old-call')).toBe(true);
      expect(isExpiredMutation(session, 'new-call')).toBe(false);
    });

    it('measures TTL against the injected now instead of the wall clock', () => {
      const startedAt = '2024-01-01T00:00:00.000Z';
      session.activeOperations = {
        'call-1': {
          callId: 'call-1',
          agent: 'agent-1',
          kind: 'mutation',
          startedAt,
          status: 'running',
          round: 0,
        },
      };

      const justBeforeExpiry = new Date(Date.parse(startedAt) + MUTATION_TTL_MS - 1).toISOString();
      const atExpiry = new Date(Date.parse(startedAt) + MUTATION_TTL_MS).toISOString();

      expect(isExpiredMutation(session, 'call-1', justBeforeExpiry)).toBe(false);
      expect(isExpiredMutation(session, 'call-1', atExpiry)).toBe(true);
    });
  });

  describe('clearActiveMutation', () => {
    it('removes the active operation', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      clearActiveMutation(session, 'call-1');

      expect(session.activeOperations['call-1']).toBeUndefined();
    });

    it('is no-op when operation does not exist', () => {
      clearActiveMutation(session, 'non-existent');

      expect(session.activeOperations).toEqual({});
    });

    it('uses callId from operation when not provided', () => {
      const resolveStage = () => 'executing';
      beginMutation(session, 'call-1', 'agent-1', resolveStage, 'tasks');

      clearActiveMutation(session);

      expect(session.activeOperations['call-1']).toBeUndefined();
    });
  });
});
