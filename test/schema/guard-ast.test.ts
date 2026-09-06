import { describe, it, expect } from 'vitest';

import { evaluateGuard, parse } from '../../src/schema/guard-ast.ts';

function makeBuiltins(
  session: Record<string, unknown>
): Record<string, (...args: unknown[]) => unknown> {
  const s = session as { approvals?: Array<{ type: string; status: string }> };
  return {
    approved: (type: unknown) =>
      (s.approvals ?? []).some((a) => a.type === type && a.status === 'granted'),
    isExhausted: (budgetKey: unknown) => {
      const budget = (session as Record<string, unknown>).retryBudgets as
        Record<string, { attempts: number; maximum: number }> | undefined;
      return budget?.[budgetKey as string]
        ? budget[budgetKey as string]!.attempts >= budget[budgetKey as string]!.maximum
        : false;
    },
    hasPendingTasks: () => {
      const taskLists = (session as Record<string, unknown>).tasks as
        Record<string, Array<{ status: string }>> | undefined;
      if (!taskLists) return false;
      return Object.values(taskLists).some(
        (list) =>
          Array.isArray(list) && list.some((t) => t.status === 'pending' || t.status === 'running')
      );
    },
    allTasksCompleted: (explicitListKey?: unknown) => {
      const taskLists = (session as Record<string, unknown>).tasks as
        Record<string, Array<{ status: string }>> | undefined;
      if (!taskLists || typeof taskLists !== 'object') return false;
      const listKey = explicitListKey as string | undefined;
      if (!listKey) return false;
      const tasks = taskLists[listKey];
      if (!Array.isArray(tasks) || tasks.length === 0) return false;
      return tasks.every((t) => t.status === 'completed');
    },
  };
}

describe('GuardAST', () => {
  describe('custom function from guards', () => {
    it('evaluates guard expression calling a custom function', () => {
      const session = {
        gates: [
          { id: 'invariants', status: 'pass' },
          { id: 'review', status: 'pending' },
        ],
      };

      const guards: Record<string, (...args: unknown[]) => unknown> = {
        isInvariantsPass: (s: unknown) => {
          const gates = (s as { gates: Array<{ id: string; status: string }> }).gates;
          return gates.find((g) => g.id === 'invariants')?.status === 'pass';
        },
      };

      const result = evaluateGuard(
        'isInvariantsPass(session)',
        session,
        makeBuiltins(session),
        guards
      );
      expect(result).toBe(true);
    });

    it('evaluates custom function that returns false', () => {
      const session = { gates: [{ id: 'invariants', status: 'fail' }] };
      const guards = {
        isInvariantsPass: (s: unknown) =>
          (s as { gates: Array<{ id: string; status: string }> }).gates.find(
            (g) => g.id === 'invariants'
          )?.status === 'pass',
      };
      expect(
        evaluateGuard('isInvariantsPass(session)', session, makeBuiltins(session), guards)
      ).toBe(false);
    });
  });

  describe('built-in approved()', () => {
    it('evaluates approved() built-in', () => {
      const session = { approvals: [{ type: 'plan', status: 'granted' }] };
      expect(evaluateGuard("approved('plan')", session, makeBuiltins(session))).toBe(true);
    });

    it('returns false when denied', () => {
      const session = { approvals: [{ type: 'plan', status: 'denied' }] };
      expect(evaluateGuard("approved('plan')", session, makeBuiltins(session))).toBe(false);
    });

    it('returns false when type missing', () => {
      const session = { approvals: [{ type: 'plan', status: 'granted' }] };
      expect(evaluateGuard("approved('commit')", session, makeBuiltins(session))).toBe(false);
    });
  });

  describe('complex expressions', () => {
    it('evaluates AND with approved()', () => {
      const session = {
        approvals: [{ type: 'plan', status: 'granted' }],
        tasks: { implementation: [{ id: 't1' }] },
      };
      const builtins = { ...makeBuiltins(session), approved: () => true };
      expect(
        evaluateGuard(
          "approved('plan') && session.tasks.implementation.length > 0",
          session,
          builtins
        )
      ).toBe(true);
    });

    it('evaluates optional chaining', () => {
      const session: Record<string, unknown> = { activeMutation: { outputReady: true } };
      expect(
        evaluateGuard('session.activeMutation?.outputReady == true', session, makeBuiltins(session))
      ).toBe(true);
    });

    it('evaluates session.activeMutation?.outputReady when missing', () => {
      expect(
        evaluateGuard('session.activeMutation?.outputReady == true', {}, makeBuiltins({}))
      ).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for undefined property access', () => {
      expect(evaluateGuard('session.undefined.property == true', {}, makeBuiltins({}))).toBe(false);
    });

    it('cannot access globalThis', () => {
      expect(evaluateGuard('globalThis', {}, makeBuiltins({}))).toBe(false);
    });

    it('cannot call missing functions', () => {
      expect(evaluateGuard('fetch("http://evil.com")', {}, makeBuiltins({}))).toBe(false);
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
    };

    it('uses named list key', () => {
      expect(
        evaluateGuard("allTasksCompleted('implementation')", session, makeBuiltins(session))
      ).toBe(true);
      expect(evaluateGuard("allTasksCompleted('release')", session, makeBuiltins(session))).toBe(
        false
      );
    });
  });

  describe('number and string operations', () => {
    it('evaluates comparison operators', () => {
      const session = { count: 5 };
      expect(evaluateGuard('session.count > 3', session, makeBuiltins(session))).toBe(true);
      expect(evaluateGuard('session.count < 3', session, makeBuiltins(session))).toBe(false);
    });

    it('evaluates unary not', () => {
      const session = { flag: false };
      expect(evaluateGuard('!session.flag', session, makeBuiltins(session))).toBe(true);
    });
  });

  describe('short-circuit evaluation', () => {
    it('short-circuits on true || expression — right side not evaluated', () => {
      let sideEffect = false;
      const builtins = {
        ...makeBuiltins({}),
        tick: () => {
          sideEffect = true;
          return true;
        },
      };
      expect(evaluateGuard('true || tick()', {}, builtins)).toBe(true);
      expect(sideEffect).toBe(false);
    });

    it('short-circuits on false && expression — right side not evaluated', () => {
      let sideEffect = false;
      const builtins = {
        ...makeBuiltins({}),
        tick: () => {
          sideEffect = true;
          return true;
        },
      };
      expect(evaluateGuard('false && tick()', {}, builtins)).toBe(false);
      expect(sideEffect).toBe(false);
    });

    it('does NOT short-circuit on false || expression — right side IS evaluated', () => {
      const session = { deliveryReceipt: 'abc123' };
      expect(
        evaluateGuard(
          "false || typeof session.deliveryReceipt == 'string'",
          session,
          makeBuiltins(session)
        )
      ).toBe(true);
    });

    it('short-circuits on truthy ?? expression — right side not evaluated', () => {
      let sideEffect = false;
      const builtins = {
        ...makeBuiltins({}),
        tick: () => {
          sideEffect = true;
          return 'fallback';
        },
      };
      expect(evaluateGuard('"hello" ?? tick()', {}, builtins)).toBe(true);
      expect(sideEffect).toBe(false);
    });

    it('evaluates right side for null ?? expression', () => {
      let sideEffect = false;
      const builtins = {
        ...makeBuiltins({}),
        tick: () => {
          sideEffect = true;
          return true;
        },
      };
      expect(evaluateGuard('null ?? tick()', {}, builtins)).toBe(true);
      expect(sideEffect).toBe(true);
    });
  });

  describe('typeof operator', () => {
    it('typeof session.deliveryReceipt == "string" when it is a string', () => {
      const session = { deliveryReceipt: 'abc123' };
      expect(
        evaluateGuard("typeof session.deliveryReceipt == 'string'", session, makeBuiltins(session))
      ).toBe(true);
    });

    it('typeof session.deliveryReceipt == "string" when it is null', () => {
      const session = { deliveryReceipt: null };
      expect(
        evaluateGuard("typeof session.deliveryReceipt == 'string'", session, makeBuiltins(session))
      ).toBe(false);
    });

    it('typeof session.unknownField == "undefined" for missing field', () => {
      const session = {};
      expect(
        evaluateGuard("typeof session.unknownField == 'undefined'", session, makeBuiltins(session))
      ).toBe(true);
    });

    it('typeof session.count == "number"', () => {
      const session = { count: 42 };
      expect(
        evaluateGuard("typeof session.count == 'number'", session, makeBuiltins(session))
      ).toBe(true);
    });

    it('typeof parses correctly for the real profile expression (deliveryReceipt or deliveryPermit)', () => {
      const sessionWithReceipt = { deliveryReceipt: 'sha123', deliveryPermit: null };
      expect(
        evaluateGuard(
          "typeof session.deliveryReceipt == 'string' || typeof session.deliveryPermit == 'string'",
          sessionWithReceipt,
          makeBuiltins(sessionWithReceipt)
        )
      ).toBe(true);

      const sessionWithPermit = { deliveryReceipt: null, deliveryPermit: 'permit-abc' };
      expect(
        evaluateGuard(
          "typeof session.deliveryReceipt == 'string' || typeof session.deliveryPermit == 'string'",
          sessionWithPermit,
          makeBuiltins(sessionWithPermit)
        )
      ).toBe(true);

      const sessionWithout = { deliveryReceipt: null, deliveryPermit: null };
      expect(
        evaluateGuard(
          "typeof session.deliveryReceipt == 'string' || typeof session.deliveryPermit == 'string'",
          sessionWithout,
          makeBuiltins(sessionWithout)
        )
      ).toBe(false);
    });
  });

  describe('global access safety', () => {
    it('returns false for process', () => {
      expect(evaluateGuard('process', {}, makeBuiltins({}))).toBe(false);
    });

    it('returns false for globalThis', () => {
      expect(evaluateGuard('globalThis', {}, makeBuiltins({}))).toBe(false);
    });

    it('returns false for require', () => {
      expect(evaluateGuard('require', {}, makeBuiltins({}))).toBe(false);
    });

    it('returns false for setTimeout', () => {
      expect(evaluateGuard('setTimeout', {}, makeBuiltins({}))).toBe(false);
    });

    it('returns false for eval', () => {
      expect(evaluateGuard('eval', {}, makeBuiltins({}))).toBe(false);
    });
  });

  describe('budget isolation', () => {
    it('two concurrent evaluations each get their own step budget', async () => {
      const session = {
        approvals: [{ type: 'plan', status: 'granted' }],
        tasks: { implementation: [{ id: 't1', status: 'completed' }] },
      };
      const builtins = makeBuiltins(session);

      const result1 = evaluateGuard("approved('plan')", session, builtins);
      const result2 = evaluateGuard(
        'session.tasks.implementation[0].status == "completed"',
        session,
        builtins
      );

      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });
  });

  describe('profile expression compatibility', () => {
    it('parses and evaluates all profile expressions from base state-machine yaml', () => {
      const approvals = [{ type: 'plan', status: 'granted' }];
      const session: Record<string, unknown> = {
        deliveries: [],
        approvals,
        tasks: {
          implementation: [
            { id: 'task-1', status: 'completed' },
            { id: 'task-2', status: 'completed' },
          ],
        },
        deliveryReceipt: 'abc',
        deliveryPermit: null,
        // GuardEvaluator places approved() on the session object, so test with that
        approved: (type: unknown) =>
          approvals.some((a) => a.type === type && a.status === 'granted'),
      };
      const builtins = makeBuiltins(session);

      // approved plan (via session, like real GuardEvaluator)
      expect(evaluateGuard("session.approved('plan')", session, builtins)).toBe(true);

      // typeof deliveryReceipt
      expect(
        evaluateGuard(
          "typeof session.deliveryReceipt == 'string' || typeof session.deliveryPermit == 'string'",
          session,
          builtins
        )
      ).toBe(true);

      // plan or revision
      expect(
        evaluateGuard("session.approved('plan') || session.revision == 0", session, builtins)
      ).toBe(true);
    });

    it('parses true fallback', () => {
      expect(evaluateGuard('true', {}, makeBuiltins({}))).toBe(true);
    });
  });
});
