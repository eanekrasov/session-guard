import { describe, it, expect } from 'vitest';

import { GuardEvaluator } from '../../src/schema/guard-evaluator.ts';

describe('GuardEvaluator', () => {
  describe('custom function from guards', () => {
    it('evaluates guard expression calling a custom function', () => {
      const session = {
        gates: [
          { id: 'invariants', status: 'pass' },
          { id: 'review', status: 'pending' },
        ],
      };

      const guards = {
        isInvariantsPass: (s: typeof session) =>
          s.gates.find((g: { id: string; status: string }) => g.id === 'invariants')?.status ===
          'pass',
      };

      const evaluator = new GuardEvaluator(session, guards);

      const result = evaluator.evaluate('isInvariantsPass(session)');

      expect(result).toBe(true);
    });

    it('evaluates custom function that returns false', () => {
      const session = {
        gates: [{ id: 'invariants', status: 'fail' }],
      };

      const guards = {
        isInvariantsPass: (s: typeof session) =>
          s.gates.find((g: { id: string; status: string }) => g.id === 'invariants')?.status ===
          'pass',
      };

      const evaluator = new GuardEvaluator(session, guards);

      const result = evaluator.evaluate('isInvariantsPass(session)');

      expect(result).toBe(false);
    });
  });

  describe('guard expression using approved()', () => {
    it('evaluates actionGuard expression with approved()', () => {
      const session = {
        approvals: [{ type: 'plan', status: 'granted' }],
        tasks: [{ id: 't1' }],
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate("session.approved('plan')");

      expect(result).toBe(true);
    });

    it('returns false when approval has denied status', () => {
      const session = {
        approvals: [{ type: 'plan', status: 'denied' }],
        tasks: [],
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate("session.approved('plan')");

      expect(result).toBe(false);
    });

    it('returns false when approval type does not exist', () => {
      const session = {
        approvals: [{ type: 'plan', status: 'granted' }],
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate("session.approved('commit')");

      expect(result).toBe(false);
    });
  });

  describe('granted() no longer works', () => {
    it('returns false for granted() since it was replaced by approved()', () => {
      const session = {
        approvals: [{ type: 'plan', status: 'granted' }],
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate("session.granted('plan')");

      expect(result).toBe(false);
    });
  });

  describe('complex expressions', () => {
    it('evaluates expression with logical AND and approved()', () => {
      const session = {
        approvals: [{ type: 'plan', status: 'granted' }],
        tasks: { implementation: [{ id: 't1' }] },
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate(
        "session.approved('plan') && session.tasks.implementation.length > 0"
      );

      expect(result).toBe(true);
    });

    it('evaluates expression with method calls like .find()', () => {
      const session = {
        gates: [{ id: 'invariants', status: 'passed' }],
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate(
        "session.gates.find(g => g.id === 'invariants')?.status === 'passed'"
      );

      expect(result).toBe(true);
    });

    it('evaluates expression with optional chaining', () => {
      const session: { activeMutation?: { outputReady?: boolean } } = {
        activeMutation: { outputReady: true },
      };

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate('session.activeMutation?.outputReady == true');

      expect(result).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns false for expressions that throw', () => {
      const session = {};

      const evaluator = new GuardEvaluator(session);

      const result = evaluator.evaluate('session.undefined.property == true');

      expect(result).toBe(false);
    });
  });

  describe('allTasksCompleted()', () => {
    const session = {
      tasks: {
        implementation: [
          { id: 'task-1', status: 'completed' },
          { id: 'task-2', status: 'completed' },
        ],
        release: [{ id: 'task-3', status: 'pending' }],
      },
      loopRuns: {
        'run-1': {
          id: 'run-1',
          taskId: 'task-1',
          listKey: 'implementation',
          stage: 'qa',
          status: 'running',
        },
      },
      activeOperations: {
        'call-1': {
          callId: 'call-1',
          runId: 'run-1',
          taskId: 'task-1',
          agent: 'qa',
          status: 'running',
        },
      },
    };

    it('uses the current run list when called without a list key', () => {
      expect(new GuardEvaluator(session).evaluate('allTasksCompleted()')).toBe(true);
    });

    it('uses the named task list when a list key is provided', () => {
      expect(new GuardEvaluator(session).evaluate("allTasksCompleted('implementation')")).toBe(
        true
      );
      expect(new GuardEvaluator(session).evaluate("allTasksCompleted('release')")).toBe(false);
    });

    it('fails closed for an unknown or ambiguous active list', () => {
      const ambiguous = {
        ...session,
        loopRuns: {
          'run-1': { ...session.loopRuns['run-1'], status: 'running' },
          'run-2': {
            id: 'run-2',
            taskId: 'task-3',
            listKey: 'release',
            stage: 'dev',
            status: 'running',
          },
        },
        activeOperations: {
          ...session.activeOperations,
          'call-2': {
            callId: 'call-2',
            runId: 'run-2',
            taskId: 'task-3',
            agent: 'qa',
            status: 'running',
          },
        },
      };

      expect(new GuardEvaluator(ambiguous).evaluate('allTasksCompleted()')).toBe(false);
      expect(new GuardEvaluator(session).evaluate("allTasksCompleted('missing')")).toBe(false);
    });

    it('uses explicit evaluation context instead of unrelated terminal run history', () => {
      const historicalSession = {
        tasks: session.tasks,
        activeOperations: {},
        loopRuns: {
          'run-implementation': { ...session.loopRuns['run-1'], status: 'completed' },
          'run-release': {
            id: 'run-release',
            taskId: 'task-3',
            listKey: 'release',
            stage: 'qa',
            status: 'completed',
          },
        },
      };

      expect(new GuardEvaluator(historicalSession).evaluate('allTasksCompleted()')).toBe(false);
      expect(
        new GuardEvaluator(historicalSession, undefined, {
          currentLoopListKey: 'implementation',
        }).evaluate('allTasksCompleted()')
      ).toBe(true);
    });
  });
});
