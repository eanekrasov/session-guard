import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatchCommand,
  isDuplicate,
  resetIdCounter,
  genId,
  type WorkflowSnapshot,
} from '../../src/domain/workflow-model.ts';

function createSnapshot(): { snapshot: WorkflowSnapshot; commandId: string; now: string } {
  resetIdCounter();
  const now = '2026-09-05T00:00:00.000Z';
  const commandId = genId();
  const { snapshot } = dispatchCommand(
    null,
    { kind: 'create', definitionDigest: 'abc123', title: 'test-run', input: {} },
    commandId,
    now
  );
  return { snapshot: snapshot!, commandId, now };
}

describe('WorkflowModel', () => {
  describe('create', () => {
    it('creates a snapshot with initial revision 1', () => {
      const { snapshot } = createSnapshot();
      expect(snapshot.formatVersion).toBe(3);
      expect(snapshot.run.revision).toBe(1);
      expect(snapshot.run.status).toBe('active');
      expect(snapshot.run.definitionDigest).toBe('abc123');
      expect(snapshot.scopes).toHaveProperty(snapshot.run.rootScopeId);
      expect(Object.keys(snapshot.executions)).toHaveLength(1);
      expect(Object.keys(snapshot.attempts)).toHaveLength(1);
    });
  });

  describe('complete', () => {
    it('marks an attempt as completed and creates a result record', () => {
      const { snapshot: s1, now } = createSnapshot();
      const execId = Object.keys(s1.executions)[0];
      const exec = s1.executions[execId];
      const attemptId = exec.currentAttemptId;

      // First set attempt to running (simplified: direct mutation for test setup)
      const runningSnapshot: WorkflowSnapshot = {
        ...s1,
        attempts: {
          ...s1.attempts,
          [attemptId]: { ...s1.attempts[attemptId], status: 'running' },
        },
      };

      const executionRef = { scopeId: exec.scopeId, executionId: execId, attemptId };
      const { snapshot: s2, validations } = dispatchCommand(
        runningSnapshot,
        {
          kind: 'complete',
          execution: executionRef,
          bindingId: 'b1',
          outcome: 'succeeded',
          summary: 'done',
          outputs: {},
        },
        genId(),
        now
      );

      expect(validations).toHaveLength(0);
      expect(s2.run.revision).toBe(2);
      expect(s2.attempts[attemptId].status).toBe('completed');
      expect(s2.attempts[attemptId].resultId).toBeDefined();
      expect(s2.executions[execId].status).toBe('finished');

      const result = Object.values(s2.results)[0];
      expect(result).toBeDefined();
      expect(result.outcome).toBe('succeeded');
      expect(result.recordedRevision).toBe(2);
    });

    it('rejects completion of non-running attempt', () => {
      const { snapshot: s1, now } = createSnapshot();
      const execId = Object.keys(s1.executions)[0];
      const exec = s1.executions[execId];
      const executionRef = {
        scopeId: exec.scopeId,
        executionId: execId,
        attemptId: exec.currentAttemptId,
      };

      const { validations } = dispatchCommand(
        s1,
        {
          kind: 'complete',
          execution: executionRef,
          bindingId: 'b1',
          outcome: 'succeeded',
          summary: '',
          outputs: {},
        },
        genId(),
        now
      );

      expect(validations.length).toBeGreaterThan(0);
      expect(validations[0].code).toBe('INVALID_ATTEMPT_STATUS');
    });

    it('rejects completion of unknown execution', () => {
      const { snapshot: s1, now } = createSnapshot();
      const execRef = { scopeId: 'x', executionId: 'nonexistent', attemptId: 'x' };

      const { validations } = dispatchCommand(
        s1,
        {
          kind: 'complete',
          execution: execRef,
          bindingId: 'b1',
          outcome: 'succeeded',
          summary: '',
          outputs: {},
        },
        genId(),
        now
      );

      expect(validations.length).toBeGreaterThan(0);
      expect(validations[0].code).toBe('UNKNOWN_EXECUTION');
    });
  });

  describe('resolveDecision', () => {
    it('resolves a pending decision', () => {
      const { snapshot: s1, now } = createSnapshot();

      // Add a pending decision
      const decisionId = genId();
      const withDecision: WorkflowSnapshot = {
        ...s1,
        decisions: {
          [decisionId]: {
            id: decisionId,
            owner: { scopeId: 's1', executionId: 'e1', attemptId: 'a1' },
            purpose: 'retry',
            subjects: [],
            policy: {
              authority: 'policy',
              allowedActors: ['*'],
              outcomes: ['increase'],
              onInvalidated: 'failed',
              onExpired: 'failed',
            },
            status: 'pending',
            resolution: null,
          },
        },
      };

      const { snapshot: s2, validations } = dispatchCommand(
        withDecision,
        { kind: 'resolveDecision', decisionId, outcome: 'increase', approvedMaximum: 3 },
        genId(),
        now
      );

      expect(validations).toHaveLength(0);
      expect(s2.decisions[decisionId].status).toBe('resolved');
      expect(s2.decisions[decisionId].resolution?.outcome).toBe('increase');
      expect(s2.run.revision).toBe(2);
    });

    it('rejects resolution of unknown decision', () => {
      const { snapshot: s1, now } = createSnapshot();
      const { validations } = dispatchCommand(
        s1,
        { kind: 'resolveDecision', decisionId: 'nonexistent', outcome: 'increase' },
        genId(),
        now
      );
      expect(validations.length).toBeGreaterThan(0);
      expect(validations[0].code).toBe('UNKNOWN_DECISION');
    });
  });

  describe('cancelScope', () => {
    it('cancels an active scope', () => {
      const { snapshot: s1, now } = createSnapshot();
      const scopeId = s1.run.rootScopeId;

      const { snapshot: s2, validations } = dispatchCommand(
        s1,
        { kind: 'cancelScope', scopeId },
        genId(),
        now
      );

      expect(validations).toHaveLength(0);
      expect(s2.scopes[scopeId].status).toBe('cancelled');
      expect(s2.run.revision).toBe(2);
    });
  });

  describe('duplicate detection', () => {
    it('detects duplicate commands by fingerprint', () => {
      const { snapshot: s1 } = createSnapshot();
      const cmdId = genId();

      const isDup = isDuplicate(s1, cmdId);
      expect(isDup).toBe(false);

      // Add the command
      const withCmd = {
        ...s1,
        appliedCommands: {
          ...s1.appliedCommands,
          [genId()]: { id: genId(), fingerprint: cmdId, appliedRevision: 1, createdIds: [] },
        },
      };

      expect(isDuplicate(withCmd, cmdId)).toBe(true);
    });
  });

  describe('two commands at the same revision', () => {
    it('increments revision on each command', () => {
      const { snapshot: s1, now } = createSnapshot();
      const execId = Object.keys(s1.executions)[0];
      const exec = s1.executions[execId];

      // First command
      const runningSnapshot: WorkflowSnapshot = {
        ...s1,
        attempts: {
          ...s1.attempts,
          [exec.currentAttemptId]: { ...s1.attempts[exec.currentAttemptId], status: 'running' },
        },
      };
      const ref = { scopeId: exec.scopeId, executionId: execId, attemptId: exec.currentAttemptId };
      const { snapshot: s2 } = dispatchCommand(
        runningSnapshot,
        {
          kind: 'complete',
          execution: ref,
          bindingId: 'b1',
          outcome: 'succeeded',
          summary: 'first',
          outputs: {},
        },
        genId(),
        now
      );
      expect(s2.run.revision).toBe(2);

      // Confirm a second command bumps it again
      const scopeId = s2.run.rootScopeId;
      const { snapshot: s3 } = dispatchCommand(s2, { kind: 'cancelScope', scopeId }, genId(), now);
      expect(s3.run.revision).toBe(3);
    });
  });
});
