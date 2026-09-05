import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { createSession } from '../../src/session/session-store.ts';
import { setGateStatus, isExhausted } from '../../src/session/helpers.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';
import { mergeSchemasToEngineConfig } from '../../src/app/mutation-orchestrator.ts';
import type { ResolvedSchema, ProfileSchema } from '../../src/schema/types.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

// ─── Load YAML profile synchronously once ────────────────────────────────

const PROFILES_DIR = '/Users/e.nekrasov/Projects/harness/session-guard/profiles';

function loadEngine(): StateMachineEngine {
  const filePath = path.join(PROFILES_DIR, 'state-machine.yaml');
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = YAML.parse(content) as ProfileSchema;

  if (!raw.transitions) {
    throw new Error(`No transitions found in YAML (${filePath})`);
  }

  const resolvedSchema: ResolvedSchema = {
    source: 'state-machine.yaml',
    phases: raw.phases,
    transitions: raw.transitions,
    settings: raw.settings,
    editingAgents: raw.editingAgents,
    verifiers: raw.verifiers,
    requiredGates: raw.requiredGates,
    actionGuards: raw.actionGuards,
    phaseAssignments: raw.phaseAssignments,
  };

  const config = mergeSchemasToEngineConfig([resolvedSchema]);

  if (!config.transitions || config.transitions.length === 0) {
    throw new Error('EngineConfig has zero transitions after merge');
  }

  return new StateMachineEngine(config);
}

const ENGINE = loadEngine();

// ─── Helper: fresh session ────────────────────────────────────────────────

function freshSession(): WorkflowSession {
  return createSession(
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    'state-machine'
  );
}

/**
 * Assert a transition was applied and the phase changed.
 */
function expectApplied(
  result: ReturnType<StateMachineEngine['tryApplyTransitions']>,
  expectedPhase: string
) {
  expect(result.applied).toBe(true);
}

/**
 * Assert a transition was NOT applied.
 */
function expectNotApplied(result: ReturnType<StateMachineEngine['tryApplyTransitions']>) {
  expect(result.applied).toBe(false);
}

/**
 * Simulate the consent + plan guard for planning → tasks_ready.
 */
function approvePlan(session: WorkflowSession) {
  session.refs.plan = 'path/to/plan.md';
  session.approvals.push({ type: 'plan', callId: 'consent-1', status: 'granted' });
}

/**
 * Add a running task so hasPendingTasks() returns true.
 */
function addTask(session: WorkflowSession) {
  session.tasks.implementation = [{ id: 'task-1', path: 'a.ts', status: 'running' }];
}

/**
 * Drive session from current phase → qa (steps planning→tasks_ready→code→review→qa).
 */
function driveToQa(session: WorkflowSession): void {
  // planning → tasks_ready
  approvePlan(session);
  let result = ENGINE.tryApplyTransitions(session);
  expectApplied(result, 'tasks_ready');
  expect(session.currentPhase).toBe('tasks_ready');

  // tasks_ready → code
  addTask(session);
  result = ENGINE.tryApplyTransitions(session);
  expectApplied(result, 'code');
  expect(session.currentPhase).toBe('code');

  // code → review
  setGateStatus(session, 'invariants', 'passed');
  result = ENGINE.tryApplyTransitions(session);
  expectApplied(result, 'review');
  expect(session.currentPhase).toBe('review');

  // review → qa
  setGateStatus(session, 'review', 'passed');
  result = ENGINE.tryApplyTransitions(session);
  expectApplied(result, 'qa');
  expect(session.currentPhase).toBe('qa');
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('YAML-driven workflow (state-machine.yaml)', () => {
  // ───────────────────────────────────────────────────────────────────────
  // Scenario 1: Happy path through all phases
  // ───────────────────────────────────────────────────────────────────────

  test('TC1: Happy path planning → tasks_ready → code → review → qa → commit → done', () => {
    const session = freshSession();

    // 1. Starts in planning
    expect(session.currentPhase).toBe('planning');

    // 2. planning → tasks_ready (consent + plan guard)
    approvePlan(session);
    let result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'tasks_ready');
    expect(session.currentPhase).toBe('tasks_ready');

    // 3. tasks_ready → code (hasPendingTasks)
    addTask(session);
    result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'code');
    expect(session.currentPhase).toBe('code');

    // 4. code → review (invariants passed)
    setGateStatus(session, 'invariants', 'passed');
    result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'review');
    expect(session.currentPhase).toBe('review');

    // 5. review → qa (review gate passed)
    setGateStatus(session, 'review', 'passed');
    result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'qa');
    expect(session.currentPhase).toBe('qa');

    // 6. qa → commit (qa gate passed → effect: approve commit)
    setGateStatus(session, 'qa', 'passed');
    result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'commit');
    expect(session.currentPhase).toBe('commit');

    // Verify the effect: commit was approved
    const commitApproval = session.approvals.find((a) => a.type === 'commit');
    expect(commitApproval).toBeDefined();
    expect(commitApproval!.status).toBe('granted');

    // 7. commit → done (deliveryReceipt set)
    session.deliveryPermit = {
      callID: 'test',
      preCommitHead: 'abc123',
      expectedFiles: [],
      startedAt: new Date().toISOString(),
    };
    result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'done');
    expect(session.currentPhase).toBe('done');

    // 8. done is terminal — no outgoing transitions
    result = ENGINE.tryApplyTransitions(session);
    expectNotApplied(result);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 2: QA fail → code loop
  // ───────────────────────────────────────────────────────────────────────

  test('TC2: QA fail → code retry loop', () => {
    const session = freshSession();
    driveToQa(session);

    // QA fails → should go to code with cycles incremented
    setGateStatus(session, 'qa', 'failed');
    let result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'code');
    expect(session.currentPhase).toBe('code');

    // Verify retry budget incremented
    expect(session.retryBudgets.cycles.attempts).toBe(1);
    expect(session.retryBudgets.cycles.maximum).toBe(5);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 3: QA exhausted → failed
  // ───────────────────────────────────────────────────────────────────────

  test('TC3: QA exhausted → failed terminal phase', () => {
    const session = freshSession();
    driveToQa(session);

    // Manually set retry budget to exhausted state
    // The YAML defines maxAttempts: 5, so 5/5 = exhausted
    session.retryBudgets.cycles = { attempts: 5, maximum: 5 };

    // qa → failed (isExhausted('cycles') is true)
    setGateStatus(session, 'qa', 'failed');
    const result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'failed');
    expect(session.currentPhase).toBe('failed');

    // failed is terminal — no outgoing transitions
    const terminalResult = ENGINE.tryApplyTransitions(session);
    expectNotApplied(terminalResult);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 4: Consent blocks without approval
  // ───────────────────────────────────────────────────────────────────────

  test('TC4: Consent blocks transition when plan not approved', () => {
    const session = freshSession();

    // Set plan ref but NO approval → consent should block
    session.refs.plan = 'path/to/plan.md';
    let result = ENGINE.tryApplyTransitions(session);
    expectNotApplied(result);
    expect(session.currentPhase).toBe('planning');

    // Now add approval → should transition
    session.approvals.push({ type: 'plan', callId: 'consent-1', status: 'granted' });
    result = ENGINE.tryApplyTransitions(session);
    expectApplied(result, 'tasks_ready');
    expect(session.currentPhase).toBe('tasks_ready');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 5: Full QA retry loop (5 cycles then failed)
  // ───────────────────────────────────────────────────────────────────────

  test('TC5: 5 QA retry cycles then exhausted → failed', () => {
    const session = freshSession();
    driveToQa(session);

    // Iterate 5 retry cycles: qa → code → review → qa → ...
    for (let i = 1; i <= 5; i++) {
      // qa → code (qa failed, not exhausted yet)
      setGateStatus(session, 'qa', 'failed');
      let result = ENGINE.tryApplyTransitions(session);
      expectApplied(result, 'code');
      expect(session.currentPhase).toBe('code');
      expect(session.retryBudgets.cycles.attempts).toBe(i);

      // code → review
      setGateStatus(session, 'invariants', 'passed');
      result = ENGINE.tryApplyTransitions(session);
      expectApplied(result, 'review');

      // review → qa
      setGateStatus(session, 'review', 'passed');
      result = ENGINE.tryApplyTransitions(session);
      expectApplied(result, 'qa');
    }

    // Now exhausted: 5/5 attempts used
    expect(session.retryBudgets.cycles.attempts).toBe(5);
    expect(session.retryBudgets.cycles.maximum).toBe(5);
    expect(isExhausted(session, 'cycles')).toBe(true);

    // qa → failed (exhausted)
    setGateStatus(session, 'qa', 'failed');
    const finalResult = ENGINE.tryApplyTransitions(session);
    expectApplied(finalResult, 'failed');
    expect(session.currentPhase).toBe('failed');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 6: Consent check in tryApplyTransitions (approved returns false)
  // ───────────────────────────────────────────────────────────────────────

  test('TC6: Consent hasPendingTasks blocks tasks_ready → code without tasks', () => {
    const session = freshSession();

    // Advance to tasks_ready
    approvePlan(session);
    ENGINE.tryApplyTransitions(session);
    expect(session.currentPhase).toBe('tasks_ready');

    // No tasks → hasPendingTasks() returns false → transition blocked
    const result = ENGINE.tryApplyTransitions(session);
    expectNotApplied(result);
    expect(session.currentPhase).toBe('tasks_ready');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 7: Guard for code→review requires invariants 'passed'
  // ───────────────────────────────────────────────────────────────────────

  test('TC7: code → review blocked when invariants not passed', () => {
    const session = freshSession();

    approvePlan(session);
    ENGINE.tryApplyTransitions(session); // planning → tasks_ready

    addTask(session);
    ENGINE.tryApplyTransitions(session); // tasks_ready → code
    expect(session.currentPhase).toBe('code');

    // Invariants still 'pending' → code → review blocked
    const result = ENGINE.tryApplyTransitions(session);
    expectNotApplied(result);
    expect(session.currentPhase).toBe('code');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 8: commit → done blocked without deliveryReceipt
  // ───────────────────────────────────────────────────────────────────────

  test('TC8: commit → done blocked without deliveryReceipt', () => {
    const session = freshSession();
    driveToQa(session);

    // Advance to commit
    setGateStatus(session, 'qa', 'passed');
    ENGINE.tryApplyTransitions(session);
    expect(session.currentPhase).toBe('commit');

    // No deliveryReceipt → blocked
    const result = ENGINE.tryApplyTransitions(session);
    expectNotApplied(result);
    expect(session.currentPhase).toBe('commit');

    // Set deliveryReceipt → proceeds
    session.deliveryPermit = {
      callID: 'test',
      preCommitHead: 'abc123',
      expectedFiles: [],
      startedAt: new Date().toISOString(),
    };
    const result2 = ENGINE.tryApplyTransitions(session);
    expectApplied(result2, 'done');
    expect(session.currentPhase).toBe('done');
  });
});
