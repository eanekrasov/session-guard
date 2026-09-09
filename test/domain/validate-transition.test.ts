import { describe, it, expect } from 'vitest';
import type { TransitionDef } from '../../src/schema/types.ts';
import type { SessionFacts } from '../../src/domain/session-facts.ts';
import { checkTransition as checkTransition } from '../../src/domain/engine.ts';

describe('checkTransition', () => {
  it('allows a valid transition without a guard', () => {
    const transitions: TransitionDef[] = [{ from: 'PLANNING', to: 'EXECUTION' }];

    const result = checkTransition('PLANNING', 'EXECUTION', transitions);

    expect(result.allowed).toBe(true);
  });

  it('blocks an illegal transition (pair not found)', () => {
    const transitions: TransitionDef[] = [{ from: 'PLANNING', to: 'EXECUTION' }];

    const result = checkTransition('EXECUTION', 'DONE', transitions);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: EXECUTION → DONE');
  });

  it('allows when a guarded transition passes with approved()', () => {
    const transitions: TransitionDef[] = [
      { from: 'PLANNING', to: 'EXECUTION', guard: "session.approved('plan')" },
    ];
    const session = {
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
    } as unknown as SessionFacts;

    const result = checkTransition('PLANNING', 'EXECUTION', transitions, session);

    expect(result.allowed).toBe(true);
  });

  it('blocks when a guarded transition fails with approved()', () => {
    const transitions: TransitionDef[] = [
      { from: 'PLANNING', to: 'EXECUTION', guard: "session.approved('plan')" },
    ];
    const session = { approvals: [] } as unknown as SessionFacts;

    const result = checkTransition('PLANNING', 'EXECUTION', transitions, session);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      "Transition guard failed for PLANNING → EXECUTION: session.approved('plan')"
    );
  });

  it('refuses a guarded transition when no session is provided', () => {
    // An unevaluated guard is not a satisfied one. Without a session there is
    // nothing to evaluate against, so the edge is refused with the reason.
    const transitions: TransitionDef[] = [
      { from: 'PLANNING', to: 'EXECUTION', guard: "session.approved('plan')" },
    ];

    const result = checkTransition('PLANNING', 'EXECUTION', transitions);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot be checked without a session');
  });

  it('allows an unconditional transition when no session is provided', () => {
    // No guard, no consent, no kind — the answer is about the shape of the
    // graph and needs no session.
    const transitions: TransitionDef[] = [{ from: 'PLANNING', to: 'EXECUTION' }];

    expect(checkTransition('PLANNING', 'EXECUTION', transitions).allowed).toBe(true);
  });

  it('evaluates a guard with gate lookup from SessionFacts', () => {
    const transitions: TransitionDef[] = [
      { from: 'EXECUTION', to: 'COMMIT', guard: 'session.gates.invariants == "passed"' },
    ];
    const session = {
      gates: { invariants: 'passed', review: 'pending' },
    } as unknown as SessionFacts;

    const result = checkTransition('EXECUTION', 'COMMIT', transitions, session);

    expect(result.allowed).toBe(true);
  });

  it('blocks transition for empty transitions array', () => {
    const transitions: TransitionDef[] = [];

    const result = checkTransition('PLANNING', 'EXECUTION', transitions);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: PLANNING → EXECUTION');
  });

  it('allows transition with null guard', () => {
    const transitions: TransitionDef[] = [{ from: 'PLANNING', to: 'EXECUTION' }];

    const result = checkTransition('PLANNING', 'EXECUTION', transitions);

    expect(result.allowed).toBe(true);
  });

  it('allows transition with empty guard', () => {
    const transitions: TransitionDef[] = [{ from: 'PLANNING', to: 'EXECUTION', guard: '' }];

    const result = checkTransition('PLANNING', 'EXECUTION', transitions);

    expect(result.allowed).toBe(true);
  });

  it('selects the correct pair from multiple transitions', () => {
    const transitions: TransitionDef[] = [
      { from: 'PLANNING', to: 'PLANNING' },
      { from: 'PLANNING', to: 'EXECUTION' },
      { from: 'EXECUTION', to: 'DONE' },
    ];

    const result = checkTransition('PLANNING', 'EXECUTION', transitions);

    expect(result.allowed).toBe(true);
  });

  describe('transitions with guard', () => {
    it('allows when guard passes', () => {
      const transitions: TransitionDef[] = [{ from: 'EXECUTION', to: 'COMMIT' }];
      const session = {
        gates: { invariants: 'passed', review: 'passed' },
      } as unknown as SessionFacts;

      const result = checkTransition('EXECUTION', 'COMMIT', transitions, session);

      expect(result.allowed).toBe(true);
    });

    it('refuses a guarded transition without session', () => {
      const transitions: TransitionDef[] = [{ from: 'EXECUTION', to: 'COMMIT', guard: 'x == 1' }];

      const result = checkTransition('EXECUTION', 'COMMIT', transitions);

      expect(result.allowed).toBe(false);
    });
  });
});
