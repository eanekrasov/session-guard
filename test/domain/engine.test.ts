import { describe, it, expect } from 'vitest';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { EngineConfig } from '../../src/domain/engine.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';

function makeSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    sessionId: 'test-session',
    profileId: 'android',
    schemaVersion: 1,
    revision: 0,
    title: '',
    gates: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    loopRuns: {},
    testStatus: {},
    deliveryReceipt: null,
    deliveryPermit: null,
    verifications: [],
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    baselineHashes: [],
    changedFiles: [],
    invariantViolations: [],
    consentedCallIDs: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    stageAssignments: [],
    transitions: [],
    actionGuards: {},
    ...overrides,
  };
}

describe('StateMachineEngine', () => {
  it('derives PLANNING stage through engine', () => {
    const config = makeConfig({
      stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
    });
    const engine = new StateMachineEngine(config);
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
    const engine = new StateMachineEngine(config);
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
    });

    const stage = engine.deriveStage(session);

    expect(stage).toBe('EXECUTION');
  });

  it('canPerformAction returns allowed when no guards', () => {
    const engine = new StateMachineEngine(makeConfig({ actionGuards: {} }));
    const session = makeSession();

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result).toEqual({ allowed: true });
  });

  it('canPerformAction returns allowed when guard passes', () => {
    const engine = new StateMachineEngine(
      makeConfig({ actionGuards: { beginMutation: "session.approved('plan')" } })
    );
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
    });

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result).toEqual({ allowed: true });
  });

  it('canPerformAction returns blocked when guard fails', () => {
    const engine = new StateMachineEngine(
      makeConfig({ actionGuards: { beginMutation: "session.approved('plan')" } })
    );
    const session = makeSession({ approvals: [] });

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result).toEqual({
      allowed: false,
      reason: "Action guard failed for beginMutation: session.approved('plan')",
    });
  });

  it('canPerformAction only checks guard for the specific action', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        actionGuards: { beginMutation: "session.approved('plan')" },
      })
    );
    const session = makeSession({ approvals: [] });

    // different action (confirm) — no guard configured, should be allowed
    const result = engine.canPerformAction(session, 'confirm');

    expect(result).toEqual({ allowed: true });
  });

  // ─── Action guards (flat, resolved internally) ──────────────────────────

  it('canPerformAction blocks when actionGuard fails', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        actionGuards: { beginMutation: "session.approved('plan')" },
      })
    );
    const session = makeSession({ approvals: [] });

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result).toEqual({
      allowed: false,
      reason: "Action guard failed for beginMutation: session.approved('plan')",
    });
  });

  it('canPerformAction passes when actionGuard passes', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        actionGuards: { beginMutation: "session.approved('plan')" },
      })
    );
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
    });

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result).toEqual({ allowed: true });
  });

  // ─── Stage-level entry/exit guards ──────────────────────────────────────

  it('canPerformAction blocks when stage-level entryGuard fails', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        stageLevelGuards: {
          PLANNING: {
            entryGuards: { beginMutation: ['false'] },
          },
        },
      })
    );
    const session = makeSession();

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Stage-level guard failed');
  });

  it('canPerformAction passes when all stage-level guards pass', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        stageLevelGuards: {
          PLANNING: {
            entryGuards: { beginMutation: ['true'] },
          },
        },
      })
    );
    const session = makeSession();

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(true);
  });

  it('stage-level guards check exitGuards too', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        stageLevelGuards: {
          PLANNING: {
            exitGuards: { beginMutation: ['false'] },
          },
        },
      })
    );
    const session = makeSession();

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(false);
  });

  it('stage-level guards only check current stage', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        stageLevelGuards: {
          EXECUTION: {
            entryGuards: { beginMutation: ['false'] },
          },
        },
      })
    );
    const session = makeSession();

    // Current stage is PLANNING, guards are for EXECUTION — allowed
    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(true);
  });

  it('stage-level guard blocks even when flat actionGuard allows', () => {
    // stage-level blocks first, flat never reached
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        stageLevelGuards: {
          PLANNING: {
            entryGuards: { beginMutation: ['false'] },
          },
        },
        actionGuards: { beginMutation: 'true' },
      })
    );
    const session = makeSession();

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Stage-level guard failed');
  });

  it('checkTransition allows valid transition through engine', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
    });
    const engine = new StateMachineEngine(config);

    const result = engine.checkTransition('PLANNING', 'EXECUTION');

    expect(result.allowed).toBe(true);
  });

  it('checkTransition blocks illegal transition through engine', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
    });
    const engine = new StateMachineEngine(config);

    const result = engine.checkTransition('PLANNING', 'COMMIT');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: PLANNING → COMMIT');
  });

  it('uses custom evaluateGuardFn when provided', () => {
    const mockGuard = () => false;
    const engine = new StateMachineEngine(
      makeConfig({ actionGuards: { anyAction: 'true' } }),
      mockGuard
    );
    const session = makeSession();

    const result = engine.canPerformAction(session, 'anyAction');

    expect(result).toEqual({
      allowed: false,
      reason: 'Action guard failed for anyAction: true',
    });
  });

  it('tryApplyTransitions applies stageOverride for matching transition', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION', kind: 'auto' }],
    });
    const engine = new StateMachineEngine(config);
    const session = makeSession();

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(true);
    expect(result.applied).toBe(true);
    expect(session.currentStage).toBe('EXECUTION');
  });

  it('tryApplyTransitions does not apply when no outgoing transition matches', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION', kind: 'pass' }], // pass requires gate
    });
    const engine = new StateMachineEngine(config);
    const session = makeSession({ currentStage: 'planning' });

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(false);
    expect(result.applied).toBe(false);
    expect(session.currentStage).toBe('planning');
  });

  it('tryApplyTransitions evaluates guard before applying transition', () => {
    const config = makeConfig({
      transitions: [
        { from: 'PLANNING', to: 'EXECUTION', kind: 'auto', guard: "session.approved('plan')" },
      ],
    });
    const engine = new StateMachineEngine(config);

    // Session without plan approval — guard should block
    const session = makeSession({ approvals: [] });
    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(false);
    expect(result.applied).toBe(false);
    expect(session.currentStage).toBeUndefined();
  });

  // ─── Stage consistency tests (P2-4): deriveStage uses currentStage, not stageOverride ──

  it('tryApplyTransitions sets currentStage (not stageOverride) for matching transition', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION', kind: 'auto' }],
    });
    const engine = new StateMachineEngine(config);
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
    const engine = new StateMachineEngine(config);
    // stageOverride on the session object has no effect on deriveStage
    const session = makeSession({ stageOverride: 'COMMIT' as never });

    // deriveStage evaluates rules — rules say true -> PLANNING
    const stage = engine.deriveStage(session);
    expect(stage).toBe('PLANNING');
  });

  it('deriveStage evaluates rules when loading session from storage', () => {
    const config = makeConfig({
      stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
    });
    const engine = new StateMachineEngine(config);
    // Session has currentStage set, but deriveStage evaluates rules
    const session = makeSession();

    const stage = engine.deriveStage(session);
    expect(stage).toBe('PLANNING');
  });

  it('tryApplyTransitions does NOT re-execute transition effects on reload', () => {
    const config = makeConfig({
      transitions: [
        {
          from: 'PLANNING',
          to: 'EXECUTION',
          kind: 'auto',
          effects: [{ bumpRetry: 'task-1' }, { approve: 'plan' }],
        },
      ],
    });
    const engine = new StateMachineEngine(config);

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

  it('tryApplyTransitions tries kind=pass transition when kind=auto fails', () => {
    const config = makeConfig({
      transitions: [
        { from: 'PLANNING', to: 'COMMIT', kind: 'pass', guard: "session.approved('commit')" },
        { from: 'PLANNING', to: 'EXECUTION', kind: 'auto', guard: "session.approved('plan')" },
      ],
    });
    const engine = new StateMachineEngine(config);

    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
      gates: [{ id: 'invariants', status: 'passed' }],
    });

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(true);
    expect(result.applied).toBe(true);
    expect(session.currentStage).toBe('EXECUTION');
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
      requiredGates: [],
    });

  it('takes the alternative whose guard holds', () => {
    const engine = new StateMachineEngine(config());
    const session = makeSession();

    const result = engine.tryApplyTransitions(session);

    expect(result.applied, 'the second edge was never evaluated').toBe(true);
    expect(session.currentStage).toBe('b');
  });

  it('stays put when no alternative holds', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'a' }],
        transitions: [
          { from: 'a', to: 'b', guard: 'false' },
          { from: 'a', to: 'b', guard: 'false' },
        ],
        requiredGates: [],
      })
    );
    const session = makeSession();

    expect(engine.tryApplyTransitions(session).applied).toBe(false);
  });

  it('applies the effects of the alternative that was taken, not the first', () => {
    // The effect proves which edge ran: the blocked one grants nothing.
    const engine = new StateMachineEngine(
      makeConfig({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'a' }],
        transitions: [
          { from: 'a', to: 'b', guard: 'false', effects: [{ approve: 'wrong' }] },
          { from: 'a', to: 'b', guard: 'true', effects: [{ approve: 'right' }] },
        ],
        requiredGates: [],
      })
    );
    const session = makeSession();

    engine.tryApplyTransitions(session);

    expect(session.approvals.map((approval) => approval.type)).toEqual(['right']);
  });
});
