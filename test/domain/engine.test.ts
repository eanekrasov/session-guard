import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { EngineConfig } from '../../src/domain/engine.ts';
import { SessionGuardEngine } from '../../src/domain/engine.ts';

function makeSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  const session: WorkflowSession = {
    sessionId: 'test-session',
    profileId: 'android',
    schemaId: 'session-guard',
    schemaVersion: 1,
    revision: 0,
    title: '',
    // A session is always in some stage — `workflow-create` writes the
    // compiled workflow's first one. These tests speak the uppercase
    // vocabulary of their own fixture config, so this is theirs.
    currentStage: 'PLANNING',
    stageGateResults: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    verdictProvenance: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    verifications: [],
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    changedFiles: [],
    invariantViolations: [],
    consentedCallIDs: [],
    processedResultCallIDs: [],
  };
  Object.assign(session, overrides);
  return session;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    stageAssignments: [],
    transitions: [],
    ...overrides,
  };
}

describe('SessionGuardEngine', () => {
  it('derives PLANNING stage through engine', () => {
    const config = makeConfig({
      stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
    });
    const engine = new SessionGuardEngine(config);
    const session = makeSession();

    const stage = engine.deriveStage(session);

    expect(stage).toBe('PLANNING');
  });

  it('derives EXECUTION stage from session with plan approval', () => {
    const config = makeConfig({
      stageAssignments: [
        { id: 'p1', priority: 100, condition: "session.approved('plan')", result: 'EXECUTION' },
        { id: 'fallback', priority: 0, condition: 'true', result: 'PLANNING' },
      ],
    });
    const engine = new SessionGuardEngine(config);
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
    });

    const stage = engine.deriveStage(session);

    expect(stage).toBe('EXECUTION');
  });

  it('checkTransition allows valid transition through engine', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
    });
    const engine = new SessionGuardEngine(config);

    const result = engine.checkTransition('PLANNING', 'EXECUTION');

    expect(result.allowed).toBe(true);
  });

  it('tryApplyTransitions enforces external stage exit and entry guards', () => {
    const engine = new SessionGuardEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'a' }],
        stages: {
          a: { exitGuards: ['false'] },
          b: { entryGuards: ['false'] },
        },
        transitions: [{ from: 'a', to: 'b' }],
      })
    );
    const session = makeSession({ currentStage: 'a' });

    expect(engine.tryApplyTransitions(session)).toMatchObject({ allowed: false, applied: false });
    expect(session.currentStage).toBe('a');
  });

  it('checkTransition blocks illegal transition through engine', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
    });
    const engine = new SessionGuardEngine(config);

    const result = engine.checkTransition('PLANNING', 'COMMIT');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: PLANNING → COMMIT');
  });

  it('uses custom evaluateGuardFn when provided', () => {
    const mockGuard = () => false;
    const engine = new SessionGuardEngine(makeConfig(), mockGuard);
    const session = makeSession();

    expect(engine.evaluateGuard('true', session)).toBe(false);
  });

  it('tryApplyTransitions applies stageOverride for matching transition', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
    });
    const engine = new SessionGuardEngine(config);
    const session = makeSession();

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(true);
    expect(result.applied).toBe(true);
    expect(session.currentStage).toBe('EXECUTION');
  });

  it('tryApplyTransitions does not apply when no outgoing transition matches', () => {
    const config = makeConfig({
      // Ребро закрыто guard-ом, которому нечем стать истинным.
      transitions: [
        { from: 'PLANNING', to: 'EXECUTION', guard: "session.gates.review == 'passed'" },
      ],
    });
    const engine = new SessionGuardEngine(config);
    const session = makeSession({ currentStage: 'planning' });

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(false);
    expect(result.applied).toBe(false);
    expect(session.currentStage).toBe('planning');
  });

  it('tryApplyTransitions evaluates guard before applying transition', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION', guard: "session.approved('plan')" }],
    });
    const engine = new SessionGuardEngine(config);

    // Session without plan approval — guard should block
    const session = makeSession({ approvals: [] });
    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(false);
    expect(result.applied).toBe(false);
    // The guard shut the only edge, so the session stayed where it was.
    expect(session.currentStage).toBe('PLANNING');
  });

  // ─── Stage consistency tests (P2-4): deriveStage uses currentStage, not stageOverride ──

  it('tryApplyTransitions sets currentStage (not stageOverride) for matching transition', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
    });
    const engine = new SessionGuardEngine(config);
    const session = makeSession();

    engine.tryApplyTransitions(session);

    // After transition, currentStage is set; stageOverride was removed from schema
    expect(session.currentStage).toBe('EXECUTION');
    expect((session as Record<string, unknown>).stageOverride).toBeUndefined();
  });

  it('deriveStage ignores stageOverride (dead field, never read)', () => {
    const config = makeConfig({
      stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
    });
    const engine = new SessionGuardEngine(config);
    // stageOverride on the session object has no effect on deriveStage
    const session = makeSession({ stageOverride: 'COMMIT' } as never);

    // deriveStage evaluates rules — rules say true -> PLANNING
    const stage = engine.deriveStage(session);
    expect(stage).toBe('PLANNING');
  });

  it('tryApplyTransitions does NOT re-execute transition effects on reload', () => {
    const config = makeConfig({
      transitions: [
        {
          from: 'PLANNING',
          to: 'EXECUTION',
          effects: [{ bumpRetry: 'task-1' }, { approve: 'plan' }],
        },
      ],
    });
    const engine = new SessionGuardEngine(config);

    // Session that already has currentStage=EXECUTION (simulating reload)
    const session = makeSession({
      currentStage: 'EXECUTION',
      retryBudgets: { 'task-1': { attempts: 0, maximum: 3 } },
    });

    // tryApplyTransitions only scans transitions from the DERIVED stage.
    // If deriveStage returns a different stage than currentStage, it doesn't mean
    // effects are re-executed — transitions are checked from the derived stage.
    // deriveStage evaluates rules; with no rules, it falls back to currentStage 'EXECUTION'.
    const result = engine.tryApplyTransitions(session);
    // No outgoing transitions from EXECUTION in this config
    expect(result.applied).toBe(false);

    // Budget stays untouched because no transition effects fired
    expect(session.retryBudgets['task-1'].attempts).toBe(0);
    expect(session.approvals.length).toBe(0);
  });

  it('tries the next edge when the first one is closed', () => {
    const config = makeConfig({
      transitions: [
        { from: 'PLANNING', to: 'COMMIT', guard: "session.approved('commit')" },
        { from: 'PLANNING', to: 'EXECUTION', guard: "session.approved('plan')" },
      ],
    });
    const engine = new SessionGuardEngine(config);

    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
      stageGateResults: [{ stage: 'EXECUTION', id: 'invariants', status: 'passed' }],
    });

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(true);
    expect(result.applied).toBe(true);
    expect(session.currentStage).toBe('EXECUTION');
  });
});

describe('onFailure: retry', () => {
  // Two edges leave the same stage on a failure: one goes round again, one
  // gives up. `onFailure` is what tells them apart — the field was accepted,
  // compiled and read by nobody, so both profiles declaring it described
  // behaviour that did not exist.
  function retryingEngine(maximum?: number): SessionGuardEngine {
    return new SessionGuardEngine({
      stages: {
        execution: maximum === undefined ? {} : { retryBudget: { maximum } },
        failed: {},
      },
      stageAssignments: [],
      transitions: [
        { from: 'execution', to: 'execution', onFailure: 'retry' },
        { from: 'execution', to: 'failed', onFailure: 'terminal' },
      ],
    } as EngineConfig);
  }

  function failingSession(): WorkflowSession {
    return makeSession({
      currentStage: 'execution',
      stageGateResults: [{ stage: 'EXECUTION', id: 'review', status: 'failed' }],
    });
  }

  it('spends one attempt of the stage’s budget each time it is taken', () => {
    const engine = retryingEngine(3);
    const session = failingSession();

    engine.tryApplyTransitions(session);

    expect(session.currentStage).toBe('execution');
    expect(session.retryBudgets['execution']).toEqual({ attempts: 1, maximum: 3 });
  });

  it('closes once the budget is spent, and the stage is left by the other edge', () => {
    const engine = retryingEngine(2);
    const session = failingSession();

    engine.tryApplyTransitions(session); // attempt 1
    engine.tryApplyTransitions(session); // attempt 2 — budget now spent
    expect(session.currentStage).toBe('execution');

    engine.tryApplyTransitions(session);

    // `terminal` needs no rule of its own: the retry edge simply stops being
    // eligible, and the next open edge out of the stage is taken.
    expect(session.currentStage).toBe('failed');
    expect(session.retryBudgets['execution']?.attempts).toBe(2);
  });

  it('says which budget closed the edge', () => {
    const engine = retryingEngine(1);
    const session = failingSession();
    engine.tryApplyTransitions(session);
    session.currentStage = 'execution';

    const check = engine.checkTransition('execution', 'execution', session);

    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('spent the retry budget for execution');
  });

  it('falls back to the default budget when the stage declares none', () => {
    const engine = retryingEngine();
    const session = failingSession();

    engine.tryApplyTransitions(session);

    expect(session.retryBudgets['execution']).toEqual({ attempts: 1, maximum: 3 });
  });
});

describe('alternative transitions between the same two stages', () => {
  // A schema may declare several edges from a to b, told apart by their
  // guards. Judging a candidate by its endpoints re-finds the first edge every
  // time, so the second guard is never read and the session stays in a.
  const config = () =>
    makeConfig({
      stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'a' }],
      transitions: [
        { from: 'a', to: 'b', guard: 'false' },
        { from: 'a', to: 'b', guard: 'true' },
      ],
    });

  it('takes the alternative whose guard holds', () => {
    const engine = new SessionGuardEngine(config());
    const session = makeSession();

    const result = engine.tryApplyTransitions(session);

    expect(result.applied, 'the second edge was never evaluated').toBe(true);
    expect(session.currentStage).toBe('b');
  });

  it('stays put when no alternative holds', () => {
    const engine = new SessionGuardEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'a' }],
        transitions: [
          { from: 'a', to: 'b', guard: 'false' },
          { from: 'a', to: 'b', guard: 'false' },
        ],
      })
    );
    const session = makeSession();

    expect(engine.tryApplyTransitions(session).applied).toBe(false);
  });

  it('applies the effects of the alternative that was taken, not the first', () => {
    // The effect proves which edge ran: the blocked one grants nothing.
    const engine = new SessionGuardEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'a' }],
        transitions: [
          { from: 'a', to: 'b', guard: 'false', effects: [{ approve: 'wrong' }] },
          { from: 'a', to: 'b', guard: 'true', effects: [{ approve: 'right' }] },
        ],
      })
    );
    const session = makeSession();

    engine.tryApplyTransitions(session);

    expect(session.approvals.map((approval) => approval.type)).toEqual(['right']);
  });
});
