import { describe, it, expect } from 'vitest';
import type { StageAssignmentRule } from '../../src/schema/types.ts';
import type { SessionFacts } from '../../src/domain/session-facts.ts';
import { deriveStageFn as deriveStage } from '../../src/domain/engine.ts';

function makeFacts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    lastApproval: null,
    approvals: [],
    tasks: [],
    activeOperations: [],
    testStatus: {},
    verifications: [],
    verified(this: SessionFacts, stage: string, status: 'confirmed' | 'rejected') {
      return this.verifications.some((v) => v.stage === stage && v.status === status);
    },
    gates: {},
    profileId: 'android',
    schemaId: 'state-machine',
    revision: 0,
    deliveryReceipt: null,
    refs: {},
    retryBudgets: {},
    isExhausted(this: SessionFacts, budgetKey: string) {
      const budget = this.retryBudgets[budgetKey];
      return budget ? budget.attempts >= budget.maximum : false;
    },
    ...overrides,
  };
}

describe('deriveStage', () => {
  it('returns the highest priority rule when condition is true', () => {
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: 'session.gates.invariants == "passed"',
        result: 'EXECUTION',
      },
      { id: 'r2', priority: 50, condition: 'true', result: 'PLANNING' },
    ];
    const facts = makeFacts({ gates: { invariants: 'passed' } });

    const result = deriveStage(facts, rules);

    expect(result).toBe('EXECUTION');
  });

  it('falls back to lower priority when higher priority condition is false', () => {
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: 'session.gates.invariants == "passed"',
        result: 'DONE',
      },
      { id: 'r2', priority: 0, condition: 'true', result: 'PLANNING' },
    ];
    const facts = makeFacts({ gates: { invariants: 'failed' } });

    const result = deriveStage(facts, rules);

    expect(result).toBe('PLANNING');
  });

  it('leaves the session where it is when no rule matches', () => {
    // Both fallbacks used to be the literal 'PLANNING'. Stage ids are
    // lowercase everywhere a profile writes them, so that value matched no
    // stage in any workflow — task admission then refused with "does not
    // declare an executable task loop" and checkTransition reported an illegal
    // transition naming a stage that does not exist. A stage nobody selected
    // has not been left.
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: "session.verified('bug', 'confirmed')",
        result: 'VERIFY',
      },
    ];
    const facts = makeFacts({ verifications: [], currentStage: 'execution' });

    expect(deriveStage(facts, rules)).toBe('execution');
  });

  it('leaves the session where it is for an empty rules array', () => {
    const facts = makeFacts({ currentStage: 'execution' });

    expect(deriveStage(facts, [])).toBe('execution');
  });

  it('answers with no stage when there is none to keep', () => {
    // Only synthetic facts reach this: a real session always carries
    // `currentStage`, written by `workflow.create` from the compiled
    // workflow's own first stage.
    expect(deriveStage(makeFacts(), [])).toBe('');
  });

  it('skips a rule with a broken expression (safe-fail) and matches next', () => {
    const rules: StageAssignmentRule[] = [
      { id: 'r1', priority: 100, condition: 'session.nonexistent.field == true', result: 'BROKEN' },
      { id: 'r2', priority: 50, condition: 'true', result: 'PLANNING' },
    ];
    const facts = makeFacts();

    const result = deriveStage(facts, rules);

    expect(result).toBe('PLANNING');
  });

  it('evaluates expression with SessionFacts fields like gates', () => {
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: 'session.gates.invariants == "passed"',
        result: 'EXECUTION',
      },
    ];
    const facts = makeFacts({
      gates: { invariants: 'passed' },
    });

    const result = deriveStage(facts, rules);

    expect(result).toBe('EXECUTION');
  });

  it('correctly resolves three-way priority: skips r100, matches r50', () => {
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: "session.verified('bug', 'confirmed')",
        result: 'VERIFY',
      },
      { id: 'r2', priority: 50, condition: 'session.tasks.length > 0', result: 'EXECUTION' },
      { id: 'r3', priority: 0, condition: 'true', result: 'PLANNING' },
    ];
    const facts = makeFacts({ tasks: [{ id: 't1', status: 'running' }] });

    const result = deriveStage(facts, rules);

    expect(result).toBe('EXECUTION');
  });

  it('returns VERIFY when bug stage is confirmed', () => {
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: "session.verified('bug', 'confirmed')",
        result: 'VERIFY',
      },
      { id: 'r2', priority: 0, condition: 'true', result: 'PLANNING' },
    ];
    const facts = makeFacts({ verifications: [{ stage: 'bug', status: 'confirmed' }] });

    const result = deriveStage(facts, rules);

    expect(result).toBe('VERIFY');
  });

  it('skips r100 false, skips r50 false, matches r0 true', () => {
    const rules: StageAssignmentRule[] = [
      {
        id: 'r1',
        priority: 100,
        condition: "session.verified('bug', 'confirmed')",
        result: 'VERIFY',
      },
      { id: 'r2', priority: 50, condition: 'session.tasks.length > 10', result: 'EXECUTION' },
      { id: 'r3', priority: 0, condition: 'true', result: 'PLANNING' },
    ];
    const facts = makeFacts({ verifications: [] });

    const result = deriveStage(facts, rules);

    expect(result).toBe('PLANNING');
  });
});
