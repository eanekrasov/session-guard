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
    phaseOverride: null,
    invariantViolations: [],
    consentedCallIDs: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    phaseAssignments: [],
    transitions: [],
    actionGuards: {},
    ...overrides,
  };
}

describe('StateMachineEngine', () => {
  it('derives PLANNING phase through engine', () => {
    const config = makeConfig({
      phaseAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
    });
    const engine = new StateMachineEngine(config);
    const session = makeSession();

    const phase = engine.derivePhase(session);

    expect(phase).toBe('PLANNING');
  });

  it('derives EXECUTION phase from session with plan approval', () => {
    const config = makeConfig({
      phaseAssignments: [
        { id: 'p1', priority: 100, condition: "session.approved('plan')", result: 'EXECUTION' },
        { id: 'fallback', priority: 0, condition: 'true', result: 'PLANNING' },
      ],
    });
    const engine = new StateMachineEngine(config);
    const session = makeSession({
      approvals: [{ type: 'plan', callId: 'c1', status: 'granted' }],
    });

    const phase = engine.derivePhase(session);

    expect(phase).toBe('EXECUTION');
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

  // ─── Phase-level entry/exit guards ──────────────────────────────────────

  it('canPerformAction blocks when phase-level entryGuard fails', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        phaseAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        phaseLevelGuards: {
          PLANNING: {
            entryGuards: { beginMutation: ['false'] },
          },
        },
      })
    );
    const session = makeSession();

    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Phase-level guard failed');
  });

  it('canPerformAction passes when all phase-level guards pass', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        phaseAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        phaseLevelGuards: {
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

  it('phase-level guards check exitGuards too', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        phaseAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        phaseLevelGuards: {
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

  it('phase-level guards only check current phase', () => {
    const engine = new StateMachineEngine(
      makeConfig({
        phaseAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        phaseLevelGuards: {
          EXECUTION: {
            entryGuards: { beginMutation: ['false'] },
          },
        },
      })
    );
    const session = makeSession();

    // Current phase is PLANNING, guards are for EXECUTION — allowed
    const result = engine.canPerformAction(session, 'beginMutation');

    expect(result.allowed).toBe(true);
  });

  it('phase-level guard blocks even when flat actionGuard allows', () => {
    // phase-level blocks first, flat never reached
    const engine = new StateMachineEngine(
      makeConfig({
        phaseAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'PLANNING' }],
        phaseLevelGuards: {
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
    expect(result.reason).toContain('Phase-level guard failed');
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
    expect(result.reason).toBe('Illegal phase transition: PLANNING → COMMIT');
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

  it('tryApplyTransitions applies phaseOverride for matching transition', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION', kind: 'auto' }],
    });
    const engine = new StateMachineEngine(config);
    const session = makeSession();

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(true);
    expect(result.applied).toBe(true);
    expect(session.phaseOverride).toBe('EXECUTION');
  });

  it('tryApplyTransitions does not apply when no outgoing transition matches', () => {
    const config = makeConfig({
      transitions: [{ from: 'PLANNING', to: 'EXECUTION', kind: 'pass' }], // pass requires gate
    });
    const engine = new StateMachineEngine(config);
    const session = makeSession();

    const result = engine.tryApplyTransitions(session);

    expect(result.allowed).toBe(false);
    expect(result.applied).toBe(false);
    expect(session.phaseOverride).toBeNull();
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
    expect(session.phaseOverride).toBeNull();
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
    expect(session.phaseOverride).toBe('EXECUTION');
  });
});
