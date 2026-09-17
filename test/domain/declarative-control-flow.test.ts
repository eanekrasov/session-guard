import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { baseGates } from '../support/task-factory.ts';
import { SessionGuardEngine, type EngineConfig } from '../../src/domain/engine.ts';
import { compileWorkflow, type CompiledWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';

function createSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  const session: WorkflowSession = {
    sessionId: 'ctrl-test',
    profileId: 'base',
    schemaId: 'session-guard',
    schemaVersion: 1,
    revision: 0,
    title: 'Control flow test',
    stageGateResults: baseGates(),
    approvals: [],
    refs: {},
    tasks: { implementation: [] },
    activeOperations: {},
    verdictProvenance: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    changedFiles: [],
    currentStage: 'PLANNING',
    invariantViolations: [],
    consentedCallIDs: [],
    processedResultCallIDs: [],
  };
  Object.assign(session, overrides);
  return session;
}

function engineFromCompiled(cw: CompiledWorkflow): SessionGuardEngine {
  return new SessionGuardEngine({
    stageAssignments: [],
    transitions: cw.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      guard: t.guard ?? undefined,
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

function engineFromSchema(schema: ResolvedSchema): SessionGuardEngine {
  const { workflow, errors } = compileWorkflow(schema);
  expect(errors).toHaveLength(0);
  return engineFromCompiled(workflow);
}

describe('declarative control flow', () => {
  describe('sequence: A → B → C', () => {
    it('advances through an ordered sequence of stages with auto transitions', () => {
      const engine = engineFromSchema({
        source: 'test.yaml',
        id: 'test',
        stages: { START: {}, MIDDLE: {}, END: {} },
        transitions: [
          { from: 'START', to: 'MIDDLE' },
          { from: 'MIDDLE', to: 'END' },
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
        id: 'test',
        stages: { CHOOSE: { stages: { step: {} } }, PATH_A: {}, PATH_B: {} },
        transitions: [
          { from: 'CHOOSE', to: 'PATH_A', guard: "session.gates.review == 'passed'" },
          { from: 'CHOOSE', to: 'PATH_B' },
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
        id: 'test',
        stages: { CHOOSE: { stages: { step: {} } }, PATH_A: {}, PATH_B: {} },
        transitions: [
          { from: 'CHOOSE', to: 'PATH_A', guard: "session.gates.review == 'passed'" },
          { from: 'CHOOSE', to: 'PATH_B' },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CHOOSE' }],
      });

      const session = createSession({ currentStage: 'CHOOSE' });
      session.stageGateResults = session.stageGateResults.map((g) =>
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
        id: 'test',
        stages: { ACTIVE: {}, DONE: {} },
        transitions: [{ from: 'ACTIVE', to: 'DONE' }],
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
        id: 'test',
        // `DONE` — не часть предмета теста, а требование компилятора: workflow
        // без стадии, из которой не ведёт ни одного ребра, не заканчивается
        // никогда. Её ребро охраняется противоположным условием к retry, так
        // что на путь повтора оно не влияет.
        stages: {
          CODE: { stages: { dev: {} } },
          REVIEW: { stages: { check: {} } },
          DONE: {},
        },
        transitions: [
          { from: 'CODE', to: 'REVIEW' },
          {
            from: 'REVIEW',
            to: 'CODE',
            guard: "session.gates.review == 'failed'",
            effects: [{ bumpRetry: 'cycles', maxAttempts: 3 }],
          },
          { from: 'REVIEW', to: 'DONE', guard: "session.gates.review == 'passed'" },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'CODE' }],
      });

      const session = createSession({ currentStage: 'CODE' });

      // CODE → REVIEW
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('REVIEW');

      // Fail review, budget not exhausted → back to CODE
      session.stageGateResults = session.stageGateResults.map((g) =>
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
        id: 'test',
        stages: { START: {}, LOOP: {}, END: {} },
        transitions: [
          { from: 'START', to: 'LOOP' },
          { from: 'LOOP', to: 'END', guard: "session.gates.qa == 'passed'" },
          { from: 'LOOP', to: 'START', guard: "session.gates.qa == 'failed'" },
        ],
        stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
      });

      const session = createSession({ currentStage: 'START' });

      // START → LOOP
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('LOOP');

      // LOOP → START (re-entry)
      session.stageGateResults = session.stageGateResults.map((g) =>
        g.id === 'qa' ? { ...g, status: 'failed' } : g
      );
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('START');

      // START → LOOP again (second occurrence)
      engine.tryApplyTransitions(session);
      expect(session.currentStage).toBe('LOOP');
    });
  });
});
