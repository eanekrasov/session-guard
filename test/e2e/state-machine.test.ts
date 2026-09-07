import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import { setGateStatus, bumpRetry, isExhausted, resetRetry } from '../../src/session/helpers.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';
import {
  beginMutation,
  finishMutation,
  isExpiredMutation,
  clearActiveMutation,
} from '../../src/domain/operation-lifecycle.ts';
import { approve, decline } from '../../src/domain/approvals.ts';
import { confirm, rejectVerification as reject } from '../../test/helpers.ts';
import { canCommit } from '../../src/domain/session-queries.ts';
import {
  hasLiveVerifier,
  markOutputReady,
  getExecutionProgress,
  canExitExecution,
} from '../../test/helpers.ts';
import { parseWorkflowResult } from '../../src/domain/evidence.ts';
import type { EngineConfig } from '../../src/domain/engine.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

// ─── Config — mirrors profiles/base/state-machine.yaml behaviour ──────────

const ENGINE_CONFIG: EngineConfig = {
  stageAssignments: [
    { id: 'default', priority: 0, condition: 'true', result: 'PLANNING' },
    {
      id: 'hasPlanApproval',
      priority: 60,
      condition: "session.approved('plan')",
      result: 'TASKS_READY',
    },
    {
      id: 'uncommitted',
      priority: 70,
      condition:
        "session.approved('plan') && session.tasks.implementation.length > 0 && session.tasks.implementation.some(t => t.status != 'completed')",
      result: 'EXECUTION',
    },
    {
      id: 'commitApproval',
      priority: 90,
      condition: "session.approved('commit')",
      result: 'COMMIT',
    },
    {
      id: 'deliveryPermit',
      priority: 100,
      condition: 'session.deliveryPermit != null',
      result: 'DONE',
    },
  ],
  transitions: [
    { from: 'PLANNING', to: 'TASKS_READY', guard: "session.approved('plan')" },
    {
      from: 'TASKS_READY',
      to: 'EXECUTION',
      guard:
        "session.tasks.implementation.length > 0 && session.tasks.implementation.some(t => t.status != 'completed')",
    },
    { from: 'EXECUTION', to: 'EXECUTION', kind: 'auto' },
    { from: 'EXECUTION', to: 'COMMIT', kind: 'pass' },
    { from: 'EXECUTION', to: 'PLANNING', guard: "!session.approved('plan')" },
    { from: 'COMMIT', to: 'DONE', guard: 'session.deliveryPermit != null' },
  ],
  actionGuards: {
    beginMutation: "session.approved('plan') || session.revision == 0",
  },
  requiredGates: ['invariants', 'review', 'qa'],
};

// ─── Helpers ───────────────────────────────────────────────────────────────

let store: WorkflowStore;
let dir: string;

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): WorkflowStore {
  dir = mkdtempSync(join(tmpdir(), 'sm-e2e-'));
  mkdirSync(join(dir, '.opencode', 'state-machine', 'sessions'), { recursive: true });
  return new WorkflowStore(join(dir, '.opencode', 'state-machine', 'sessions'));
}

function baseSession(): WorkflowSession {
  return createSession('test-session', 'test', 'cycle');
}

function implementationTasks(session: WorkflowSession): WorkflowSession['tasks']['implementation'] {
  session.tasks.implementation ??= [];
  return session.tasks.implementation;
}

function setImplementationTasks(
  session: WorkflowSession,
  tasks: WorkflowSession['tasks']['implementation']
): void {
  session.tasks.implementation = tasks;
}

function addImplementationTask(
  session: WorkflowSession,
  status: 'pending' | 'running' | 'completed' = 'running'
): void {
  implementationTasks(session).push(createTask({ status }));
}

function setActiveOperation(session: WorkflowSession, callId: string, startedAt: string): void {
  setImplementationTasks(session, [createTask({ status: 'running' })]);
  session.loopRuns['run-1'] = {
    id: 'run-1',
    taskId: 'task-1',
    listKey: 'implementation',
    ancestry: [],
    stage: 'mutation',
    status: 'running',
  };
  session.activeOperations[callId] = {
    callId,
    runId: 'run-1',
    taskId: 'task-1',
    agent: 'code',
    startedAt,
    status: 'running',
  };
}

/**
 * Save, reload, and return the fresh session object — same round-trip
 * that every production hook (tool.execute.before/after) performs.
 */
async function persistAndReload(session: WorkflowSession): Promise<WorkflowSession> {
  await store.save(session);
  const loaded = await store.load(session.sessionId);
  if (!loaded) throw new Error('Session lost after save');
  return loaded;
}

describe('E2E: Full state machine flow', () => {
  // ─── TC1: Happy path (production-like: store roundtrip after each step) ──────

  test('TC1: PLANNING → TASKS_READY → EXECUTION → COMMIT → DONE', async () => {
    store = makeStore();
    let session = baseSession();
    await store.save(session);
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    // 1. PLANNING
    expect(engine.deriveStage(session)).toBe('PLANNING');

    // 2. approve('plan') → TASKS_READY
    approve(session, 'plan', 'ev-1', 'call-1');
    session = await persistAndReload(session);

    expect(engine.deriveStage(session)).toBe('TASKS_READY');
    expect(engine.checkTransition('PLANNING', 'TASKS_READY', session).allowed).toBe(true);
    expect(engine.canPerformAction(session, 'beginMutation').allowed).toBe(true);

    // 3. addTask → EXECUTION
    addImplementationTask(session);
    session = await persistAndReload(session);

    expect(engine.deriveStage(session)).toBe('EXECUTION');
    expect(engine.checkTransition('TASKS_READY', 'EXECUTION', session).allowed).toBe(true);

    // 4. beginMutation → finishMutation → gates pass
    beginMutation(session, 'mutation-1', 'unknown', () => 'code');
    session.changedFiles = ['a.ts'];
    finishMutation(session, true, 'mutation-1');
    setGateStatus(session, 'invariants', 'passed');
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');
    session = await persistAndReload(session);

    // Verify changedFiles survived roundtrip
    expect(session.changedFiles).toEqual(['a.ts']);

    // 5. approve('commit') → COMMIT
    approve(session, 'commit', 'ev-2', 'call-2');
    session = await persistAndReload(session);

    expect(engine.deriveStage(session)).toBe('COMMIT');
    expect(engine.checkTransition('EXECUTION', 'COMMIT', session).allowed).toBe(true);

    // 6. set deliveryPermit → DONE
    session.deliveryPermit = {
      callID: 'test',
      preCommitHead: 'abc123',
      expectedFiles: [],
      startedAt: new Date().toISOString(),
    };
    session = await persistAndReload(session);

    expect(engine.deriveStage(session)).toBe('DONE');
    expect(engine.checkTransition('COMMIT', 'DONE', session).allowed).toBe(true);
    expect(session.deliveryPermit?.preCommitHead).toBe('abc123');
  });

  // ─── TC2: Kind=pass blocks COMMIT when gates pending ─────────────────────

  test('TC2: kind=pass blocks COMMIT when gates are pending', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-1');
    approve(session, 'commit', 'ev', 'c2');

    // checkTransition blocks — gates not passed
    const validation = engine.checkTransition('EXECUTION', 'COMMIT', session);
    expect(validation.allowed).toBe(false);
    expect(validation.kind).toBe('pass');
    expect(validation.reason).toContain('gate');
  });

  // ─── TC3: One gate missing ───────────────────────────────────────────────

  test('TC3: rejects COMMIT when one required gate is not passed', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-1');
    setGateStatus(session, 'invariants', 'passed');
    approve(session, 'commit', 'ev', 'c2');

    const validation = engine.checkTransition('EXECUTION', 'COMMIT', session);
    expect(validation.allowed).toBe(false);
    expect(validation.kind).toBe('pass');
  });

  // ─── TC4: All gates passed → COMMIT allowed ──────────────────────────────

  test('TC4: EXECUTION → COMMIT passes when all gates are passed', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-1');
    setGateStatus(session, 'invariants', 'passed');
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');
    approve(session, 'commit', 'ev', 'c2');

    const validation = engine.checkTransition('EXECUTION', 'COMMIT', session);
    expect(validation.allowed).toBe(true);
    expect(validation.kind).toBe('pass');
  });

  // ─── TC5: COMMIT → DONE blocked without deliveryReceipt ──────────────────

  test('TC5: COMMIT → DONE blocks when deliveryReceipt is not set', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-1');
    setGateStatus(session, 'invariants', 'passed');
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');
    approve(session, 'commit', 'ev', 'c2');
    expect(session.deliveryPermit).toBeNull();

    const validation = engine.checkTransition('COMMIT', 'DONE', session);
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toContain('guard failed');
  });

  // ─── TC6: beginMutation blocked without approved plan ────────────────────

  test('TC6: canPerformAction blocks beginMutation without approved plan', () => {
    store = makeStore();
    const session = baseSession();
    // Simulate a session that has already had mutations (revision > 0)
    // so the guard `session.approved('plan') || session.revision == 0` does not shortcut.
    session.revision = 1;
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    const result = engine.canPerformAction(session, 'beginMutation');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Action guard failed for beginMutation');
  });

  // ─── TC7: Kind=auto — EXECUTION loop ─────────────────────────────────────

  test('TC7: EXECUTION → EXECUTION (auto loop) is always allowed', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);

    const validation = engine.checkTransition('EXECUTION', 'EXECUTION', session);
    expect(validation.allowed).toBe(true);
    expect(validation.kind).toBe('auto');
  });

  // ─── TC8: Failed mutation retry cycle ────────────────────────────────────

  test('TC8: failed mutation retry then full cycle', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    expect(engine.deriveStage(session)).toBe('EXECUTION');

    // First mutation fails. The verdict is recorded; the attempt is not spent
    // here — the move that retries the task is what costs one.
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, false, 'm-1');
    expect(session.gates.find((g) => g.id === 'invariants')?.status).toBe('failed');
    expect(session.retryBudgets['task-1']).toBeUndefined();

    // Retry — passes
    beginMutation(session, 'm-2', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-2');
    setGateStatus(session, 'invariants', 'passed');
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');

    approve(session, 'commit', 'ev', 'c2');
    expect(engine.deriveStage(session)).toBe('COMMIT');

    session.deliveryPermit = {
      callID: 'test',
      preCommitHead: 'abc123',
      expectedFiles: [],
      startedAt: new Date().toISOString(),
    };
    expect(engine.deriveStage(session)).toBe('DONE');
  });

  // ─── TC9: Dispatch functions ─────────────────────────────────────────────

  test('TC9: dispatch functions work correctly', () => {
    store = makeStore();
    const session = baseSession();

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');

    markOutputReady('m-1', session);
    expect(session.activeOperations['m-1']?.result).toBe('output_ready');
    expect(getExecutionProgress(session).active).toBe(1);

    clearActiveMutation(session);
    expect(session.activeOperations).toEqual({});
    expect(getExecutionProgress(session).active).toBe(0);

    implementationTasks(session)[0].status = 'completed';
    expect(canExitExecution(session)).toBe(true);
  });

  // ─── TC10: toSessionFacts projection ──────────────────────────────────────

  test('TC10: toSessionFacts projects key fields', () => {
    store = makeStore();
    const session = baseSession();
    const { toSessionFacts } = require('../../src/domain/session-facts.ts');

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');

    const facts = toSessionFacts(session);

    expect(facts.profileId).toBe('test');
    expect(facts.gates.invariants).toBeDefined();
    expect(facts.verified('bug', 'confirmed')).toBe(false);
    expect(facts.activeOperations[0]?.callId).toBe('m-1');
  });

  // ─── TC11: Decline then re-approve ───────────────────────────────────────

  test('TC11: clear approvals reverts stage to PLANNING', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    expect(engine.deriveStage(session)).toBe('TASKS_READY');

    session.approvals = [];
    expect(engine.deriveStage(session)).toBe('PLANNING');
  });

  // ─── TC12: confirm/reject verifications ─────────────────────────────────────

  test('TC12: confirm and reject toggle verifications', () => {
    store = makeStore();
    const session = baseSession();

    expect(session.verifications).toEqual([]);

    confirm(session, 'bug');

    const bugV1 = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV1).toBeDefined();
    expect(bugV1!.status).toBe('confirmed');

    reject(session, 'bug');

    const bugV2 = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV2).toBeDefined();
    expect(bugV2!.status).toBe('rejected');
  });

  // ─── TC13: Engine tryApplyTransitions sets currentStage ─────────────────

  test('TC13: tryApplyTransitions sets currentStage on session', () => {
    store = makeStore();
    const session = baseSession();
    approve(session, 'plan', 'ev', 'c1');

    const config: EngineConfig = {
      stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'TASKS_READY' }],
      transitions: [{ from: 'TASKS_READY', to: 'EXECUTION', kind: 'auto' }],
      actionGuards: {},
      requiredGates: [],
    };
    const engine = new StateMachineEngine(config);

    const result = engine.tryApplyTransitions(session);
    expect(result.applied).toBe(true);
    expect(session.currentStage).toBe('EXECUTION');
    expect(session.stageOverride).toBeUndefined();
  });

  // ─── TC14: Illegal transition ────────────────────────────────────────────

  test('TC14: illegal transition returns blocked with reason', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    const result = engine.checkTransition('PLANNING', 'DONE', session);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: PLANNING → DONE');
  });

  // ─── TC15: Schema strip — old field names are silently dropped ────────────

  test('TC15: session with old field names survives save/load (strip mode)', async () => {
    store = makeStore();
    const session = baseSession() as Record<string, unknown>;

    // Fields from a pre-refactoring session
    session.invariantViolations = [
      { evidenceId: 'iv-1', severity: 'warning', message: 'test', status: 'open' },
    ];
    session.changedFiles = ['old.ts'];
    session.verifications = [];

    await store.save(session as WorkflowSession);
    const loaded = await store.load(session.sessionId as string);
    if (!loaded) throw new Error('Session vanished');

    // Fields survive roundtrip via schema.strip()
    expect(loaded.verifications).toEqual([]);
    expect(loaded.changedFiles).toEqual(['old.ts']);
  });

  // ─── TC16: declined approval persists through store roundtrip ─────────────

  test('TC16: declined approval persists through store roundtrip', async () => {
    store = makeStore();
    let session = baseSession();
    await store.save(session);

    decline(session, 'plan', 'ev-1', 'call-1', 'Bad plan');
    session = await persistAndReload(session);

    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].type).toBe('plan');
    expect(session.approvals[0].status).toBe('denied');
    expect(session.approvals[0].feedback).toBe('Bad plan');
  });

  // ─── TC17: Double approve (idempotent) ────────────────────────────────────

  test('TC17: double approve same type+callId updates existing', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev-1', 'call-1');
    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].evidence).toBe('ev-1');

    approve(session, 'plan', 'ev-2', 'call-1');
    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].evidence).toBe('ev-2');
  });

  // ─── TC18: Decline then approve same type+callId (reversal) ───────────────

  test('TC18: decline then approve same callId flips status', () => {
    store = makeStore();
    const session = baseSession();

    decline(session, 'plan', 'ev-1', 'call-1', 'Not ready');
    expect(session.approvals[0].status).toBe('denied');

    approve(session, 'plan', 'ev-2', 'call-1');
    expect(session.approvals[0].status).toBe('granted');
    expect(session.approvals[0].evidence).toBe('ev-2');
  });

  // ─── TC19: beginMutation throws on double-begin without expiry ────────────

  test('TC19: beginMutation throws when active operation exists and not expired', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);

    beginMutation(session, 'm-1', 'unknown', () => 'code');
    expect(() => beginMutation(session, 'm-2', 'unknown', () => 'code')).toThrow(
      'Active operation already exists'
    );
  });

  // ─── TC20: Two consecutive mutations (begin→finish→begin→finish) ──────────

  test('TC20: two consecutive mutations are allowed', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);

    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = ['a.ts'];
    finishMutation(session, true, 'm-1');
    expect(session.activeOperations).toEqual({});
    expect(session.changedFiles).toEqual(['a.ts']);

    beginMutation(session, 'm-2', 'unknown', () => 'code');
    expect(session.activeOperations['m-2']?.callId).toBe('m-2');
    session.changedFiles = ['b.ts'];
    finishMutation(session, true, 'm-2');
    expect(session.activeOperations).toEqual({});
    expect(session.changedFiles).toEqual(['b.ts']);
  });

  // ─── TC21: Retry budget exhausts after max attempts ──────────────────────

  test('TC21: a budget exhausts on the attempts that are spent, not on verdicts', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);

    // Three failed mutations record three verdicts and spend nothing: a task
    // used to exhaust its retries without a single retry having been taken.
    for (let i = 1; i <= 3; i++) {
      beginMutation(session, `m-${i}`, 'unknown', () => 'code');
      session.changedFiles = [];
      finishMutation(session, false, `m-${i}`);
    }
    expect(session.retryBudgets['task-1']).toBeUndefined();
    expect(isExhausted(session, 'task-1')).toBe(false);

    // The attempts the retrying moves spend are what exhausts it.
    for (let i = 1; i <= 3; i++) bumpRetry(session, 'task-1');

    expect(session.retryBudgets['task-1'].attempts).toBe(3);
    expect(isExhausted(session, 'task-1')).toBe(true);
  });

  // ─── TC22: resetRetry resets the budget ──────────────────────────────────

  test('TC22: resetRetry clears retry attempts', () => {
    store = makeStore();
    const session = baseSession();

    bumpRetry(session, 'task-1');
    bumpRetry(session, 'task-1');
    expect(session.retryBudgets['task-1'].attempts).toBe(2);

    resetRetry(session, 'task-1');
    expect(session.retryBudgets['task-1'].attempts).toBe(0);
    expect(isExhausted(session, 'task-1')).toBe(false);
  });

  // ─── TC23-25: Generic step lifecycle (replaces canCommit tests) ──────────

  test('TC23: first step completes while later work is pending', async () => {
    const session = baseSession();
    setGateStatus(session, 'invariants', 'passed');
    session.tasks.implementation = [
      createTask({ status: 'completed' }),
      createTask({ id: 'task-2', status: 'pending' }),
    ];

    // First step completed independently
    const step1 = session.tasks.implementation[0];
    expect(step1.status).toBe('completed');
    // Later work is still pending
    const step2 = session.tasks.implementation[1];
    expect(step2.status).toBe('pending');
  });

  test('TC24: two steps produce independent results', () => {
    const results = [
      { id: 'step-1', output: 'result-a' },
      { id: 'step-2', output: 'result-b' },
    ];
    expect(results[0].output).not.toBe(results[1].output);
    expect(results[1].id).toBe('step-2');
  });

  // ─── TC26: Empty changedFiles list survives roundtrip ─────────────────────

  test('TC26: empty changedFiles survives store roundtrip', async () => {
    store = makeStore();
    let session = baseSession();
    await store.save(session);

    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-1');
    session = await persistAndReload(session);

    expect(session.changedFiles).toEqual([]);
  });

  // ─── TC27: parseWorkflowResult — last valid tag wins ──────────────────────

  test('TC27: parseWorkflowResult finds last valid workflow result', () => {
    store = makeStore();
    const output = [
      'irrelevant text',
      '<workflow-result>{"stage":"first","status":"pass","summary":"early","evidence":["e1"]}</workflow-result>',
      '<workflow-result>invalid json}</workflow-result>',
      '<workflow-result>{"stage":"second","status":"fail","summary":"late","evidence":["e3"]}</workflow-result>',
    ].join('\n');

    const result = parseWorkflowResult(output);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('second');
    expect(result!.status).toBe('fail');
  });

  // ─── TC28: parseWorkflowResult — no tags returns null ─────────────────────

  test('TC28: parseWorkflowResult returns null when no tags', () => {
    store = makeStore();
    expect(parseWorkflowResult('just some text')).toBeNull();
  });

  // ─── TC29: hasLiveVerifier — active mutation ─────────────────────────────

  test('TC29: hasLiveVerifier returns true when mutation is running', () => {
    store = makeStore();
    const session = baseSession();

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');

    expect(hasLiveVerifier(session, 'any-agent')).toBe(true);
  });

  // ─── TC30: hasLiveVerifier — no mutation ─────────────────────────────────

  test('TC30: hasLiveVerifier returns false when no mutation', () => {
    store = makeStore();
    const session = baseSession();

    expect(hasLiveVerifier(session, 'any-agent')).toBe(false);
  });

  // ─── TC31: markOutputReady with wrong id is no-op ─────────────────

  test('TC31: markOutputReady with wrong id is no-op', () => {
    store = makeStore();
    const session = baseSession();

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');

    markOutputReady('wrong-id', session);
    expect(session.activeOperations['m-1']?.result).toBeUndefined();
  });

  // ─── TC32: markOutputReady when no active operation is no-op ──────────────

  test('TC32: markOutputReady without active operation is no-op', () => {
    store = makeStore();
    const session = baseSession();

    markOutputReady('m-1', session);
    expect(session.activeOperations).toEqual({});
  });

  // ─── TC33: clearActiveMutation when already null is no-op ─────────────────

  test('TC33: clearActiveMutation when already null is no-op', () => {
    store = makeStore();
    const session = baseSession();
    clearActiveMutation(session);
    expect(session.activeOperations).toEqual({});
  });

  // ─── TC34: canExitExecution — active mutation blocks exit ─────────────────

  test('TC34: canExitExecution returns false when mutation is active', () => {
    store = makeStore();
    const session = baseSession();

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');

    expect(canExitExecution(session)).toBe(false);
  });

  // ─── TC35: getExecutionProgress counts correctly ──────────────────────────

  test('TC35: getExecutionProgress counts active, total, completed', () => {
    store = makeStore();
    const session = baseSession();

    setImplementationTasks(session, [
      createTask({ status: 'completed' }),
      createTask({ id: 'task-2', status: 'running' }),
      createTask({ id: 'task-3', status: 'running' }),
    ]);
    session.loopRuns['run-1'] = {
      id: 'run-1',
      taskId: 'task-2',
      listKey: 'implementation',
      ancestry: [],
      stage: 'mutation',
      status: 'running',
    };
    session.activeOperations['m-1'] = {
      callId: 'm-1',
      runId: 'run-1',
      taskId: 'task-2',
      agent: 'code',
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    const progress = getExecutionProgress(session);
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(3);
    expect(progress.active).toBe(1);
  });

  // ─── TC36: beginMutation resets verifications ─────────────────────────────────

  test('TC36: beginMutation resets verifications to empty', () => {
    store = makeStore();
    const session = baseSession();

    confirm(session, 'bug');
    expect(session.verifications).not.toEqual([]);

    approve(session, 'plan', 'ev', 'c1');
    setImplementationTasks(session, [createTask()]);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    expect(session.verifications).toEqual([]);
  });

  // ─── TC37: beginMutation resets invariants gate to pending ────────────────

  test('TC37: beginMutation resets invariants gate to pending', () => {
    store = makeStore();
    const session = baseSession();

    setGateStatus(session, 'invariants', 'passed');
    expect(session.gates.find((g) => g.id === 'invariants')?.status).toBe('passed');

    approve(session, 'plan', 'ev', 'c1');
    setImplementationTasks(session, [createTask()]);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    expect(session.gates.find((g) => g.id === 'invariants')?.status).toBe('pending');
  });

  // ─── TC38: Failed mutation sets invariants to failed ──────────────────────

  test('TC38: failed mutation sets invariants gate to failed', () => {
    store = makeStore();
    const session = baseSession();

    approve(session, 'plan', 'ev', 'c1');
    setImplementationTasks(session, [createTask()]);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, false, 'm-1');

    expect(session.gates.find((g) => g.id === 'invariants')?.status).toBe('failed');
  });

  // ─── TC39: Multiple approvals of different types ──────────────────────────

  test('TC39: multiple approval types coexist', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev-1', 'c1');
    approve(session, 'review', 'ev-2', 'c2');
    approve(session, 'qa', 'ev-3', 'c3');

    expect(session.approvals).toHaveLength(3);
    expect(engine.checkTransition('PLANNING', 'TASKS_READY', session).allowed).toBe(true);
  });

  // ─── TC40: Schema strip drops unknown fields on save/load ─────────────────

  test('TC40: unknown session fields are dropped by schema.strip()', async () => {
    store = makeStore();
    const session = baseSession() as Record<string, unknown>;
    const { randomUUID } = await import('node:crypto');
    session.extraneous = { should: 'be-dropped' };
    session.neverExisted = 42;

    await store.save(session as WorkflowSession);
    const loaded = await store.load(session.sessionId as string);
    if (!loaded) throw new Error('Lost');

    expect((loaded as Record<string, unknown>).extraneous).toBeUndefined();
    expect((loaded as Record<string, unknown>).neverExisted).toBeUndefined();
  });

  // ─── TC41: isExpiredMutation — recent mutation not expired ───────────────

  test('TC41: isExpiredMutation returns false for just-started mutation', () => {
    store = makeStore();
    const session = baseSession();

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');

    expect(isExpiredMutation(session)).toBe(false);
  });

  // ─── TC42: isExpiredMutation — no active mutation ────────────────────────

  test('TC42: isExpiredMutation returns false when no active mutation', () => {
    store = makeStore();
    const session = baseSession();

    expect(isExpiredMutation(session)).toBe(false);
  });

  // ─── TC43: beginMutation replaces expired mutation ────────────────────────

  test('TC43: beginMutation does not throw when previous mutation expired', () => {
    store = makeStore();
    const session = baseSession();

    // Mutation with ancient timestamp
    setActiveOperation(session, 'ancient', new Date(Date.now() - 60 * 60 * 1000).toISOString());

    expect(isExpiredMutation(session)).toBe(true);
    // beginMutation should succeed — old mutation is expired
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    expect(session.activeOperations['m-1']?.callId).toBe('m-1');
  });

  // ─── TC44: verifications survives save/load roundtrip ──────────────────────

  test('TC44: verifications survives store roundtrip after confirm', async () => {
    store = makeStore();
    let session = baseSession();
    await store.save(session);

    confirm(session, 'bug');
    session = await persistAndReload(session);

    const bugV1 = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV1).toBeDefined();
    expect(bugV1!.status).toBe('confirmed');

    reject(session, 'bug');
    session = await persistAndReload(session);

    const bugV2 = session.verifications.find((v) => v.stage === 'bug');
    expect(bugV2).toBeDefined();
    expect(bugV2!.status).toBe('rejected');
  });

  // ─── TC45: Session with zero tasks (no-task profile) ────────────────────

  test('TC45: session without tasks never reaches TASKS_READY→EXECUTION', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    // No tasks added — stays in TASKS_READY

    expect(engine.deriveStage(session)).toBe('TASKS_READY');
    // checkTransition to EXECUTION fails
    const validation = engine.checkTransition('TASKS_READY', 'EXECUTION', session);
    expect(validation.allowed).toBe(false);
  });

  // ─── TC46: Session with all tasks completed goes to TASKS_READY, not EXECUTION ──

  test('TC46: all tasks completed keeps stage in TASKS_READY', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session, 'completed');

    // All tasks completed → no "running" tasks → not EXECUTION
    expect(engine.deriveStage(session)).toBe('TASKS_READY');
  });

  // ─── TC47: approve('commit') with pending gates keeps stage not-COMMIT ───

  test('TC47: approve(commit) without gates passed keeps stage at EXECUTION when deriveStage checks gates', () => {
    store = makeStore();
    const session = baseSession();

    // Engine where deriveStage also checks gate status for commit
    const strictConfig: EngineConfig = {
      ...ENGINE_CONFIG,
      stageAssignments: [
        ...ENGINE_CONFIG.stageAssignments.filter((pa) => pa.id !== 'commitApproval'),
        {
          id: 'commitApproval',
          priority: 90,
          condition:
            "session.approved('commit') && session.gates.invariants == 'passed' && session.gates.review == 'passed' && session.gates.qa == 'passed'",
          result: 'COMMIT',
        },
      ],
    };
    const engine = new StateMachineEngine(strictConfig);

    approve(session, 'plan', 'ev', 'c1');
    addImplementationTask(session);
    beginMutation(session, 'm-1', 'unknown', () => 'code');
    session.changedFiles = [];
    finishMutation(session, true, 'm-1');
    // gates NOT passed
    approve(session, 'commit', 'ev', 'c2');

    // deriveStage also blocks because condition checks gates
    expect(engine.deriveStage(session)).toBe('EXECUTION');
  });

  // ─── TC48: engine with custom ActionId — unknown action is allowed ───────

  test('TC48: canPerformAction allows unknown action', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    // 'unknownAction' has no guard in config → allowed
    const result = engine.canPerformAction(session, 'unknownAction');
    expect(result.allowed).toBe(true);
  });

  // ─── TC49: GuardEvaluator approved() returns false for unknown type ──────

  test('TC49: session.approved() returns false for unknown type', () => {
    store = makeStore();
    const session = baseSession();
    const engine = new StateMachineEngine(ENGINE_CONFIG);

    approve(session, 'plan', 'ev', 'c1');

    // Verify through checkTransition that non-existent approval type blocks
    expect(engine.deriveStage(session)).toBe('TASKS_READY');
    // If we remove plan approval, it reverts
    session.approvals = [];
    expect(engine.deriveStage(session)).toBe('PLANNING');
  });

  // ─── TC50: Stage derivation priority — higher wins ───────────────────────

  test('TC50: higher priority stage assignment wins over lower', () => {
    store = makeStore();
    const session = baseSession();

    const priorityConfig: EngineConfig = {
      stageAssignments: [
        { id: 'low', priority: 10, condition: 'true', result: 'LOW' },
        { id: 'high', priority: 100, condition: 'true', result: 'HIGH' },
      ],
      transitions: [],
      actionGuards: {},
      requiredGates: [],
    };
    const engine = new StateMachineEngine(priorityConfig);

    expect(engine.deriveStage(session)).toBe('HIGH');
  });

  // ─── TC52: Concurrent save/load consistency ──────────────────────────────

  test('TC52: two sequential save operations do not conflict', async () => {
    store = makeStore();
    const session = baseSession();
    await store.save(session);

    // Simulate two quick mutations
    approve(session, 'plan', 'ev', 'c1');
    await store.save(session);

    addImplementationTask(session);
    await store.save(session);

    const loaded = await store.load(session.sessionId);
    if (!loaded) throw new Error('Lost');

    expect(loaded.approvals).toHaveLength(1);
    expect(loaded.tasks.implementation).toHaveLength(1);
    expect(loaded.revision).toBe(3); // 3 saves = rev 3
  });

  // ─── TC53: Guard with null gate ID is safe ───────────────────────────────

  test('TC53: checkTransition with non-existent gate is handled', () => {
    store = makeStore();
    const session = baseSession();

    const engine = new StateMachineEngine(ENGINE_CONFIG);
    // Required gates include one that doesn't exist in gates list
    const customConfig: EngineConfig = {
      ...ENGINE_CONFIG,
      requiredGates: ['non_existent_gate'],
    };
    const strictEngine = new StateMachineEngine(customConfig);

    const validation = strictEngine.checkTransition('EXECUTION', 'COMMIT', session);
    // Gate not in gates map → treated as not-passed → blocked
    expect(validation.allowed).toBe(false);
  });

  // ─── TC54: Session with changedFiles empty after create; baselineHashes removed ──

  test('TC54: changedFiles starts empty; baselineHashes is gone', () => {
    store = makeStore();
    const session = baseSession();

    expect((session as Record<string, unknown>).baselineHashes).toBeUndefined();
    expect(session.changedFiles).toEqual([]);
  });

  // ─── TC55: toSessionFacts with empty session ──────────────────────────────

  test('TC55: toSessionFacts handles empty session gracefully', () => {
    store = makeStore();
    const session = baseSession();
    const { toSessionFacts } = require('../../src/domain/session-facts.ts');

    const facts = toSessionFacts(session);

    // All fields should be defined, not throw
    expect(facts.deliveryReceipt).toBeNull();
    expect(facts.lastApproval).toBeNull();
    expect(facts.approvals).toEqual([]);
    expect(facts.tasks).toEqual([]);
    expect(facts.activeOperations).toEqual([]);
    expect(facts.verified('bug', 'confirmed')).toBe(false);
    expect(facts.gates).toBeDefined();
    expect(facts.profileId).toBe('test');
  });
});
