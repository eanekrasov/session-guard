import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { CORE_GATES } from '../../src/session/session-schema.ts';
import { StateMachineEngine, type EngineConfig } from '../../src/domain/engine.ts';
import { compileWorkflow, type CompiledWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';

function createSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    sessionId: 'ctrl-test',
    profileId: 'base',
    schemaVersion: 1,
    revision: 0,
    title: 'Control flow test',
    gates: CORE_GATES.map((g) => ({ ...g })),
    approvals: [],
    refs: {},
    tasks: { implementation: [] },
    activeOperations: {},
    testStatus: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    retryBudgets: {},
    updatedAt: new Date().toISOString(),
    verifications: [],
    baselineHashes: [],
    changedFiles: [],
    currentStage: 'PLANNING',
    invariantViolations: [],
    consentedCallIDs: [],
    ...overrides,
  };
}

function engineFromCompiled(cw: CompiledWorkflow): StateMachineEngine {
  return new StateMachineEngine({
    transitions: cw.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      guard: t.guard ?? undefined,
      kind: t.kind,
      effects: t.effects
        .filter((e) => e.bumpRetry || e.approve)
        .map((e) => ({
          ...(e.bumpRetry
            ? { bumpRetry: e.bumpRetry, maxAttempts: e.maxAttempts ?? undefined }
            : {}),
          ...(e.approve ? { approve: e.approve } : {}),
        })),
    })),
    stages: {},
  });
}

function engineFromSchema(schema: ResolvedSchema): StateMachineEngine {
  const { workflow, errors } = compileWorkflow(schema);
  expect(errors).toHaveLength(0);
  return engineFromCompiled(workflow);
}

describe('declarative control flow', () => {
  describe('sequence: A → B → C', () => {
    it('advances through an ordered sequence of stages with auto transitions', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        stages: { START: {}, MIDDLE: {}, END: {} },
        transitions: [
          { from: 'START', to: 'MIDDLE', kind: 'auto' },
          { from: 'MIDDLE', to: 'END', kind: 'auto' },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
      });

      const session = createSession({ currentStage: 'START' });

      // START → MIDDLE
      const r1 = engine.tryApplyTransitions(session);
      expect(r1.applied).toBe(true);
      expect(session.currentStage).toBe('MIDDLE');

      // MIDDLE → END
      const r2 = engine.tryApplyTransitions(session);
      expect(r2.applied).toBe(true);
      expect(session.currentStage).toBe('END');

      // END — no outgoing
      const r3 = engine.tryApplyTransitions(session);
      expect(r3.applied).toBe(false);
      expect(session.currentStage).toBe('END');
    });
  });

  describe('exclusive branch', () => {
    it('chooses the first matching outgoing transition by guard', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        stages: { CHOOSE: { stages: { step: {} } }, PATH_A: {}, PATH_B: {} },
        transitions: [
          { from: 'CHOOSE', to: 'PATH_A', guard: "session.gates.review == 'passed'", kind: 'auto' },
          { from: 'CHOOSE', to: 'PATH_B', kind: 'auto' },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CHOOSE' }],
      });

      const session = createSession({ currentStage: 'CHOOSE' });

      // Neither gate passed → PATH_B (no guard, kind=auto)
      const r = engine.tryApplyTransitions(session);

      expect(r.applied).toBe(true);
      expect(session.currentStage).toBe('PATH_B');
    });

    it('takes the guarded branch when its condition is met', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        stages: { CHOOSE: { stages: { step: {} } }, PATH_A: {}, PATH_B: {} },
        transitions: [
          { from: 'CHOOSE', to: 'PATH_A', guard: "session.gates.review == 'passed'", kind: 'auto' },
          { from: 'CHOOSE', to: 'PATH_B', kind: 'auto' },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CHOOSE' }],
      });

      const session = createSession({ currentStage: 'CHOOSE' });
      session.gates = session.gates.map((g) =>
        g.id === 'review' ? { ...g, status: 'passed' } : g
      );

      const r = engine.tryApplyTransitions(session);
      expect(r.applied).toBe(true);
      expect(session.currentStage).toBe('PATH_A');
    });
  });

  describe('terminal outcome', () => {
    it('stops at an explicitly declared terminal stage', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        stages: { ACTIVE: {}, DONE: {} },
        transitions: [{ from: 'ACTIVE', to: 'DONE', kind: 'auto' }],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'ACTIVE' }],
      });

      const session = createSession({ currentStage: 'ACTIVE' });
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('DONE');

      const r = engine.tryApplyTransitions(session);
      expect(r.applied).toBe(false);
    });
  });

  describe('retry with budget', () => {
    it('resets to the retry target stage when budget is not exhausted', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        stages: { CODE: { stages: { dev: {} } }, REVIEW: { stages: { check: {} } } },
        transitions: [
          { from: 'CODE', to: 'REVIEW', kind: 'auto' },
          {
            from: 'REVIEW',
            to: 'CODE',
            guard: "session.gates.review == 'failed'",
            kind: 'auto',
            effects: [{ bumpRetry: 'cycles', maxAttempts: 3 }],
          },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CODE' }],
      });

      const session = createSession({ currentStage: 'CODE' });

      // CODE → REVIEW
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('REVIEW');

      // Fail review, budget not exhausted → back to CODE
      session.gates = session.gates.map((g) =>
        g.id === 'review' ? { ...g, status: 'failed' } : g
      );
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('CODE');
      expect(session.retryBudgets.cycles).toBeDefined();
      expect(session.retryBudgets.cycles.attempts).toBe(1);
    });
  });

  describe('node re-entry creates new occurrence context', () => {
    it('re-entering a stage after completion keeps previous result intact', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        stages: { START: {}, LOOP: {}, END: {} },
        transitions: [
          { from: 'START', to: 'LOOP', kind: 'auto' },
          { from: 'LOOP', to: 'END', guard: "session.gates.qa == 'passed'", kind: 'auto' },
          { from: 'LOOP', to: 'START', guard: "session.gates.qa == 'failed'", kind: 'auto' },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
      });

      const session = createSession({ currentStage: 'START' });

      // START → LOOP
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('LOOP');

      // LOOP → START (re-entry)
      session.gates = session.gates.map((g) => (g.id === 'qa' ? { ...g, status: 'failed' } : g));
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('START');

      // START → LOOP again (second occurrence)
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('LOOP');
    });
  });
});
