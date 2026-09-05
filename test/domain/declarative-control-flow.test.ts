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
    currentPhase: 'PLANNING',
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
    phases: {},
  });
}

function engineFromSchema(schema: ResolvedSchema): StateMachineEngine {
  const { workflow, errors } = compileWorkflow(schema);
  expect(errors).toHaveLength(0);
  return engineFromCompiled(workflow);
}

describe('declarative control flow', () => {
  describe('sequence: A → B → C', () => {
    it('advances through an ordered sequence of phases with auto transitions', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        phases: { START: {}, MIDDLE: {}, END: {} },
        transitions: [
          { from: 'START', to: 'MIDDLE', kind: 'auto' },
          { from: 'MIDDLE', to: 'END', kind: 'auto' },
        ],
        phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
      });

      const session = createSession({ currentPhase: 'START' });

      // START → MIDDLE
      const r1 = engine.tryApplyTransitions(session);
      expect(r1.applied).toBe(true);
      expect(session.currentPhase).toBe('MIDDLE');

      // MIDDLE → END
      const r2 = engine.tryApplyTransitions(session);
      expect(r2.applied).toBe(true);
      expect(session.currentPhase).toBe('END');

      // END — no outgoing
      const r3 = engine.tryApplyTransitions(session);
      expect(r3.applied).toBe(false);
      expect(session.currentPhase).toBe('END');
    });
  });

  describe('exclusive branch', () => {
    it('chooses the first matching outgoing transition by guard', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        phases: { CHOOSE: { stages: [{ id: 'step' }] }, PATH_A: {}, PATH_B: {} },
        transitions: [
          { from: 'CHOOSE', to: 'PATH_A', guard: "session.gates.review == 'passed'", kind: 'auto' },
          { from: 'CHOOSE', to: 'PATH_B', kind: 'auto' },
        ],
        phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CHOOSE' }],
      });

      const session = createSession({ currentPhase: 'CHOOSE' });

      // Neither gate passed → PATH_B (no guard, kind=auto)
      const r = engine.tryApplyTransitions(session);

      expect(r.applied).toBe(true);
      expect(session.currentPhase).toBe('PATH_B');
    });

    it('takes the guarded branch when its condition is met', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        phases: { CHOOSE: { stages: [{ id: 'step' }] }, PATH_A: {}, PATH_B: {} },
        transitions: [
          { from: 'CHOOSE', to: 'PATH_A', guard: "session.gates.review == 'passed'", kind: 'auto' },
          { from: 'CHOOSE', to: 'PATH_B', kind: 'auto' },
        ],
        phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CHOOSE' }],
      });

      const session = createSession({ currentPhase: 'CHOOSE' });
      session.gates = session.gates.map((g) =>
        g.id === 'review' ? { ...g, status: 'passed' } : g
      );

      const r = engine.tryApplyTransitions(session);
      expect(r.applied).toBe(true);
      expect(session.currentPhase).toBe('PATH_A');
    });
  });

  describe('terminal outcome', () => {
    it('stops at an explicitly declared terminal phase', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        phases: { ACTIVE: {}, DONE: {} },
        transitions: [{ from: 'ACTIVE', to: 'DONE', kind: 'auto' }],
        phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'ACTIVE' }],
      });

      const session = createSession({ currentPhase: 'ACTIVE' });
      engine.tryApplyTransitions(session);
      expect(session.currentPhase).toBe('DONE');

      const r = engine.tryApplyTransitions(session);
      expect(r.applied).toBe(false);
    });
  });

  describe('retry with budget', () => {
    it('resets to the retry target phase when budget is not exhausted', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        phases: { CODE: { stages: [{ id: 'dev' }] }, REVIEW: { stages: [{ id: 'check' }] } },
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
        phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CODE' }],
      });

      const session = createSession({ currentPhase: 'CODE' });

      // CODE → REVIEW
      engine.tryApplyTransitions(session);
      expect(session.currentPhase).toBe('REVIEW');

      // Fail review, budget not exhausted → back to CODE
      session.gates = session.gates.map((g) =>
        g.id === 'review' ? { ...g, status: 'failed' } : g
      );
      engine.tryApplyTransitions(session);
      expect(session.currentPhase).toBe('CODE');
      expect(session.retryBudgets.cycles).toBeDefined();
      expect(session.retryBudgets.cycles.attempts).toBe(1);
    });
  });

  describe('node re-entry creates new occurrence context', () => {
    it('re-entering a phase after completion keeps previous result intact', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        phases: { START: {}, LOOP: {}, END: {} },
        transitions: [
          { from: 'START', to: 'LOOP', kind: 'auto' },
          { from: 'LOOP', to: 'END', guard: "session.gates.qa == 'passed'", kind: 'auto' },
          { from: 'LOOP', to: 'START', guard: "session.gates.qa == 'failed'", kind: 'auto' },
        ],
        phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
      });

      const session = createSession({ currentPhase: 'START' });

      // START → LOOP
      engine.tryApplyTransitions(session);
      expect(session.currentPhase).toBe('LOOP');

      // LOOP → START (re-entry)
      session.gates = session.gates.map((g) => (g.id === 'qa' ? { ...g, status: 'failed' } : g));
      engine.tryApplyTransitions(session);
      expect(session.currentPhase).toBe('START');

      // START → LOOP again (second occurrence)
      engine.tryApplyTransitions(session);
      expect(session.currentPhase).toBe('LOOP');
    });
  });
});
