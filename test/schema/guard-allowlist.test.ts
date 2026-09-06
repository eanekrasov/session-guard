import { describe, expect, it } from 'vitest';
import { evaluateGuard } from '../../src/schema/guard-ast.ts';

/**
 * Guard expressions come from a YAML file and decide whether the workflow may
 * advance, so the language they run in says "no" by default: a name that is not
 * on the allowlist is not reachable, however it is written.
 */

const session = {
  tasks: {
    implementation: [
      { id: 'task-0', status: 'completed' },
      { id: 'task-1', status: 'completed' },
    ],
  },
  gates: { invariants: 'passed', review: 'pending' },
  gateKey: 'invariants',
  title: 'a plan',
};

function evaluate(expression: string, onError?: (e: Error) => void): boolean {
  return evaluateGuard(expression, session, {}, {}, onError);
}

describe('guard expressions people actually write', () => {
  it('accepts a parenthesised arrow parameter', () => {
    // `t => …` parsed; `(t) => …` did not, and the guard silently became false.
    expect(evaluate('session.tasks.implementation.every((t) => t.status == "completed")')).toBe(
      true
    );
  });

  it('accepts the bare arrow parameter too', () => {
    expect(evaluate('session.tasks.implementation.every(t => t.status == "completed")')).toBe(true);
  });

  it('accepts multiple arrow parameters', () => {
    expect(evaluate('session.tasks.implementation.some((t, i) => i == 1 && t.id == "task-1")')).toBe(
      true
    );
  });

  it('reads a dynamic key', () => {
    // `obj[expr]` compiled to an empty property name and always read undefined.
    expect(evaluate('session.gates[session.gateKey] == "passed"')).toBe(true);
    expect(evaluate('session.gates[session.gateKey] == "failed"')).toBe(false);
  });

  it('reads a dynamic key through an optional chain', () => {
    expect(evaluate('session.gates?.[session.gateKey] == "passed"')).toBe(true);
    expect(evaluate('session.missing?.[session.gateKey] == "passed"')).toBe(false);
  });

  it('still reads a missing field as undefined', () => {
    expect(evaluate('session.missing === undefined')).toBe(true);
    expect(evaluate('session.gates.review == "pending"')).toBe(true);
  });

  it('reads array elements and length', () => {
    expect(evaluate('session.tasks.implementation.length == 2')).toBe(true);
    expect(evaluate('session.tasks.implementation[1].id == "task-1"')).toBe(true);
  });

  it('chains the allowed collection methods', () => {
    expect(
      evaluate('session.tasks.implementation.map(t => t.id).includes("task-1")')
    ).toBe(true);
    expect(
      evaluate('session.tasks.implementation.filter(t => t.id == "task-0").length == 1')
    ).toBe(true);
  });
});

describe('what a guard may not reach', () => {
  for (const expression of [
    'session.constructor',
    'session.__proto__',
    'session.gates.constructor',
    'session.tasks.implementation.constructor',
    'session.title.constructor',
    'session.gates["constructor"]',
    'session.tasks.implementation.map(t => t.constructor)',
  ]) {
    it(`refuses ${expression}`, () => {
      let reported: Error | undefined;
      expect(evaluate(expression, (error) => (reported = error))).toBe(false);
      expect(reported, 'the refusal was silent').toBeDefined();
      expect(reported!.message).toMatch(/not available to guard expressions/);
    });
  }

  it('refuses a name reached through a dynamic key just as through a literal one', () => {
    expect(evaluate('session.gates[session.gateKey] == "passed"')).toBe(true);
    expect(evaluate('session["__proto__"]')).toBe(false);
  });

  it('does not hand out a method that is not on the list', () => {
    // `toString` exists on every object; it is not a guard capability.
    expect(evaluate('session.title.toString() == "a plan"')).toBe(false);
  });
});

describe('a broken guard is reported, not silently false', () => {
  it('reports a parse error', () => {
    let reported: Error | undefined;
    expect(evaluate('session.tasks. ==', (error) => (reported = error))).toBe(false);
    expect(reported, 'a guard that cannot parse failed silently').toBeDefined();
  });

  it('a legitimately false guard reports nothing', () => {
    let reported: Error | undefined;
    expect(evaluate('session.gates.review == "passed"', (error) => (reported = error))).toBe(false);
    expect(reported).toBeUndefined();
  });
});

describe('the evaluation budget covers callbacks', () => {
  it('does not give each arrow call a fresh budget', () => {
    const many = { list: Array.from({ length: 400 }, (_, index) => ({ index })) };
    // 400 elements × a body that walks another 400 exceeds the shared budget;
    // with a per-call budget this ran unbounded.
    const result = evaluateGuard(
      'session.list.every(a => session.list.every(b => b.index >= 0))',
      many,
      {},
      {}
    );
    expect(result).toBe(false);
  });
});
