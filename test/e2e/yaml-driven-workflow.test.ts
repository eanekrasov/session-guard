import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { createSession } from '../../src/session/session-store.ts';
import { setGateStatus, isExhausted } from '../../src/session/helpers.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';
import { schemaToEngineConfig } from '../../src/app/mutation-orchestrator.ts';
import type { ResolvedSchema, ProfileSchema } from '../../src/schema/types.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

// ─── Load YAML profile synchronously once ────────────────────────────────

// Resolve from this file so the suite runs on any checkout, not just the
// author's machine.
const PROFILES_DIR = path.resolve(import.meta.dirname, '../../profiles');

function loadEngine(): StateMachineEngine {
  // Exercise the schema that actually ships, not a sample copy.
  const filePath = path.join(PROFILES_DIR, 'base', 'base.yaml');
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = YAML.parse(content) as ProfileSchema;

  if (!raw.transitions) {
    throw new Error(`No transitions found in YAML (${filePath})`);
  }

  const resolvedSchema: ResolvedSchema = {
    id: 'base',
    source: 'base/base.yaml',
    stages: raw.stages,
    transitions: raw.transitions,
    settings: raw.settings,
    editingAgents: raw.editingAgents,
    stageAssignments: raw.stageAssignments,
  };

  const config = schemaToEngineConfig(resolvedSchema);

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
    'state-machine',
    'base'
  );
}

/** Assert a transition was applied and the session landed on the named stage. */
function expectApplied(
  result: ReturnType<StateMachineEngine['tryApplyTransitions']>,
  session: WorkflowSession,
  expectedStage: string
) {
  expect(result.applied, `no transition applied; stayed at ${session.currentStage}`).toBe(true);
  expect(session.currentStage).toBe(expectedStage);
}

/** Assert a transition was NOT applied and the session did not move. */
function expectNotApplied(
  result: ReturnType<StateMachineEngine['tryApplyTransitions']>,
  session: WorkflowSession,
  expectedStage: string
) {
  expect(result.applied).toBe(false);
  expect(session.currentStage).toBe(expectedStage);
}

/** The operator approves the plan, releasing planning → tasks_ready. */
function approvePlan(session: WorkflowSession) {
  session.refs.plan = 'path/to/plan.md';
  session.approvals.push({ type: 'plan', callId: 'consent-1', status: 'granted' });
}

function addTask(session: WorkflowSession, status: 'running' | 'completed' = 'running') {
  session.tasks.implementation = [createTask({ status })];
}

function completeTasks(session: WorkflowSession) {
  for (const task of session.tasks.implementation ?? []) task.status = 'completed';
}

/** Drive a fresh session to `validation`, where the verifiers report. */
function driveToValidation(session: WorkflowSession): void {
  approvePlan(session);
  expectApplied(ENGINE.tryApplyTransitions(session), session, 'tasks_ready');

  addTask(session);
  expectApplied(ENGINE.tryApplyTransitions(session), session, 'execution');

  completeTasks(session);
  expectApplied(ENGINE.tryApplyTransitions(session), session, 'validation');
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('YAML-driven workflow (profiles/base/base.yaml)', () => {
  test('TC1: happy path planning → tasks_ready → execution → validation → commit → done', () => {
    const session = freshSession();
    expect(session.currentStage).toBe('planning');

    driveToValidation(session);

    // Both verifiers report on the work as a whole.
    setGateStatus(session, 'review', 'passed');
    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'validation');
    setGateStatus(session, 'qa', 'passed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'commit');

    // Only the receipt releases done — the permit is permission to try.
    session.deliveryReceipt = 'abc123';
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'done');
  });

  test('TC1b: a failed commit does not advance to done', () => {
    const session = freshSession();
    driveToValidation(session);
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'commit');

    // The permit was issued and the commit failed: HEAD never moved.
    session.deliveryPermit = {
      callID: 'call-1',
      preCommitHead: 'abc123',
      expectedFiles: [],
      startedAt: new Date().toISOString(),
    };
    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'commit');
  });

  test('TC2: a rejected validation sends the work back into the loop', () => {
    const session = freshSession();
    driveToValidation(session);

    setGateStatus(session, 'review', 'failed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'execution');
    expect(session.retryBudgets['cycles']?.attempts).toBe(1);
  });

  test('TC2b: re-entering execution requires fresh task work', () => {
    const session = freshSession();
    driveToValidation(session);

    setGateStatus(session, 'review', 'failed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'execution');

    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'execution');
    expect(session.retryBudgets['cycles']?.attempts).toBe(1);
    expect(session.tasks.implementation[0]?.status).toBe('pending');
  });

  test('TC3: validation that has spent the retry budget ends in failed', () => {
    const session = freshSession();
    driveToValidation(session);

    session.retryBudgets['cycles'] = { attempts: 5, maximum: 5 };
    expect(isExhausted(session, 'cycles')).toBe(true);

    setGateStatus(session, 'qa', 'failed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'failed');
  });

  test('TC4: consent blocks planning → tasks_ready until the plan is approved', () => {
    const session = freshSession();
    // The plan exists, but the operator has not answered.
    session.refs.plan = 'path/to/plan.md';
    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'planning');

    session.approvals.push({ type: 'plan', callId: 'consent-1', status: 'granted' });
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'tasks_ready');
  });

  test('TC5: five rejected validations, then failed', () => {
    const session = freshSession();
    driveToValidation(session);

    for (let cycle = 1; cycle <= 5; cycle++) {
      setGateStatus(session, 'review', 'failed');
      expectApplied(ENGINE.tryApplyTransitions(session), session, 'execution');
      expect(session.retryBudgets['cycles']?.attempts).toBe(cycle);

      // The loop runs again and hands the work back to validation.
      setGateStatus(session, 'review', 'pending');
      completeTasks(session);
      expectApplied(ENGINE.tryApplyTransitions(session), session, 'validation');
    }

    expect(isExhausted(session, 'cycles')).toBe(true);
    setGateStatus(session, 'review', 'failed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'failed');
  });

  test('TC6: tasks_ready → execution waits for a task to exist', () => {
    const session = freshSession();
    approvePlan(session);
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'tasks_ready');

    // No tasks yet: hasPendingTasks() is false.
    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'tasks_ready');

    addTask(session);
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'execution');
  });

  test('TC7: execution → validation waits for every task to complete', () => {
    const session = freshSession();
    approvePlan(session);
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'tasks_ready');
    session.tasks.implementation = [
      createTask({ status: 'running' }),
      createTask({ id: 'task-2', status: 'pending' }),
    ];
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'execution');

    // One task done is not the work done.
    session.tasks.implementation[0]!.status = 'completed';
    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'execution');

    session.tasks.implementation[1]!.status = 'completed';
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'validation');
  });

  test('TC8: commit → done is blocked without a delivery receipt', () => {
    const session = freshSession();
    driveToValidation(session);
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');
    expectApplied(ENGINE.tryApplyTransitions(session), session, 'commit');

    expect(session.deliveryReceipt).toBeNull();
    expectNotApplied(ENGINE.tryApplyTransitions(session), session, 'commit');
  });
});
