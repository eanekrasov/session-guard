import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import { setGateStatus } from '../../src/session/helpers.ts';
import { StateMachineEngine } from '../../src/domain/engine.ts';
import type { EngineConfig } from '../../src/domain/engine.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

let directory = '';
let store: WorkflowStore;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    stageAssignments: [
      { id: 'always', priority: 0, condition: 'true', result: 'PLANNING' },
      { id: 'approved', priority: 100, condition: "session.approved('plan')", result: 'EXECUTION' },
      {
        id: 'gates-pass',
        priority: 200,
        condition: 'session.gates.invariants == "passed"',
        result: 'COMMIT',
      },
    ],
    transitions: [
      { from: 'PLANNING', to: 'EXECUTION', kind: 'auto', guard: "session.approved('plan')" },
      { from: 'EXECUTION', to: 'COMMIT', kind: 'pass' },
      { from: 'EXECUTION', to: 'FIXUP', kind: 'fail' },
      { from: 'COMMIT', to: 'DONE' },
    ],
    actionGuards: {},
    ...overrides,
  };
}

async function saveAndReload(session: WorkflowSession): Promise<WorkflowSession> {
  await store.save(session);
  const loaded = await store.load(session.sessionId);
  if (!loaded) throw new Error('Session disappeared after save');
  return loaded;
}

async function createWorkflowSession(
  sessionId: string,
  preset: string,
  overrides?: Partial<WorkflowSession>
): Promise<WorkflowSession> {
  const session = createSession(sessionId, preset, 'cycle');
  // Set tasks to avoid empty-state stage issues
  session.tasks.implementation = [createTask({ status: 'running' })];
  Object.assign(session, overrides);
  await store.save(session);
  return session;
}

describe('E2E: checkTransition kind=pass/fail', () => {
  describe('kind=pass — gates must all be passed', () => {
    test('allows COMMIT stage when invariants gate is passed', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-pass'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // Set sessions facts to make EXECUTION current stage
      setGateStatus(session, 'invariants', 'passed');
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      expect(result.allowed).toBe(true);
      expect(result.kind).toBe('pass');
    });

    test('blocks COMMIT stage when invariants gate is pending', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-pass-block'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // invariants is still 'pending' — not passed
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      expect(result.allowed).toBe(false);
      expect(result.kind).toBe('pass');
      expect(result.reason).toContain('invariants');
    });

    test('blocks COMMIT stage when invariants gate is failed', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-pass-fail'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      setGateStatus(session, 'invariants', 'failed');
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      expect(result.allowed).toBe(false);
      expect(result.kind).toBe('pass');
    });

    test('allows transition with empty requiredGates list', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-pass-empty'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: [] }));
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      expect(result.allowed).toBe(true);
      expect(result.kind).toBe('pass');
    });
  });

  describe('kind=fail — at least one gate must be failed', () => {
    test('allows FIXUP stage when invariants gate is failed', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-fail-allow'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      setGateStatus(session, 'invariants', 'failed');
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('EXECUTION', 'FIXUP', session);

      expect(result.allowed).toBe(true);
      expect(result.kind).toBe('fail');
    });

    test('blocks FIXUP stage when no gate is failed', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-fail-block'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // All gates passed — no failed gate
      setGateStatus(session, 'invariants', 'passed');
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('EXECUTION', 'FIXUP', session);

      expect(result.allowed).toBe(false);
      expect(result.kind).toBe('fail');
      expect(result.reason).toContain('gate');
    });

    test('kind=fail looks at any required gate — one failed is enough', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-fail-some'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // Multiple gates — one failed is enough
      setGateStatus(session, 'invariants', 'passed');
      setGateStatus(session, 'review', 'failed');
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(
        makeConfig({ requiredGates: ['invariants', 'review'] })
      );
      const result = engine.checkTransition('EXECUTION', 'FIXUP', session);

      expect(result.allowed).toBe(true);
      expect(result.kind).toBe('fail');
    });
  });

  describe('kind=auto — bypasses gate checks', () => {
    test('auto transition allowed even with pending gates', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-auto'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // Plan approved so auto transition guard passes
      session.approvals.push({ type: 'plan', callId: 'c1', status: 'granted' });
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('PLANNING', 'EXECUTION', session);

      expect(result.allowed).toBe(true);
      expect(result.kind).toBe('auto');
    });

    test('tryApplyTransitions sets currentStage on session', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-auto-apply'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');
      session.tasks.implementation = [createTask({ status: 'running' })];
      await store.save(session);

      // Engine with a no-guard auto transition from PLANNING
      const engine = new StateMachineEngine({
        stageAssignments: [{ id: 'always', priority: 0, condition: 'true', result: 'planning' }],
        transitions: [{ from: 'planning', to: 'execution', kind: 'auto' }],
        actionGuards: {},
        requiredGates: [],
      });

      const result = engine.tryApplyTransitions(session);
      expect(result.applied).toBe(true);
      expect(session.currentStage).toBe('execution');
    });
  });

  describe('guard evaluation with kind', () => {
    test('guard failure blocks transition regardless of kind', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-guard'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // Plan not approved — guard on PLANNING→EXECUTION fails (no session.granted('plan'))
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
      const result = engine.checkTransition('PLANNING', 'EXECUTION', session);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('guard failed');
    });

    test('guard passes + kind=pass gates pass = allowed', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-guard-and-kind'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      setGateStatus(session, 'invariants', 'passed');
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      // Use a transition with both guard and kind=pass
      const config = makeConfig({
        requiredGates: ['invariants'],
        transitions: [
          {
            from: 'EXECUTION',
            to: 'COMMIT',
            kind: 'pass',
            guard: 'session.tasks.implementation[0].status == "completed"',
          },
        ],
      });
      const engine = new StateMachineEngine(config);
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      expect(result.allowed).toBe(true);
      expect(result.kind).toBe('pass');
    });
  });

  describe('engine config — requiredGates resolution', () => {
    test('defaults to ["invariants"] when not specified', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-default'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // invariants is pending — should block kind=pass
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: undefined }));
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      // Default is ['invariants'], invariants is pending → blocked
      expect(result.allowed).toBe(false);
      expect(result.kind).toBe('pass');
    });

    test('uses config.requiredGates when set', async () => {
      directory = await mkdtemp(join(tmpdir(), 'sm-e2e-config'));
      store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
      const session = await createWorkflowSession('root', 'test');

      // Create the custom gate first (setGateStatus is no-op when gate doesn't exist)
      session.gates.push({ id: 'custom', status: 'passed' });
      session.gates.push({ id: 'invariants', status: 'passed' });
      session.tasks.implementation[0].status = 'completed';
      await store.save(session);

      const engine = new StateMachineEngine(makeConfig({ requiredGates: ['custom'] }));
      const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

      expect(result.allowed).toBe(true);
    });
  });
});

describe('E2E: checkTransition — engine.checkTransition integration', () => {
  test('engine.checkTransition without session refuses a conditional edge', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sm-e2e-no-session'));
    store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));

    const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
    const result = engine.checkTransition('EXECUTION', 'COMMIT');

    // No session → the gates behind kind=pass cannot be read, and unread gates
    // are not passed gates. The edge is refused, not waved through.
    expect(result.allowed).toBe(false);
    expect(result.kind).toBe('pass');
    expect(result.reason).toContain('cannot be checked without a session');
  });

  test('engine.checkTransition with session injects requiredGates', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sm-e2e-inject'));
    store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));
    const session = await createWorkflowSession('root', 'test');

    // invariants is pending — should block kind=pass
    await store.save(session);

    const engine = new StateMachineEngine(makeConfig({ requiredGates: ['invariants'] }));
    const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

    // requiredGates=['invariants'] injected, invariants is 'pending' → blocked
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('invariants');
  });

  test('illegal transition returns allowed: false', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sm-e2e-illegal'));
    store = new WorkflowStore(join(directory, '.opencode/state-machine/sessions'));

    const engine = new StateMachineEngine(makeConfig());
    const result = engine.checkTransition('PLANNING', 'DONE');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: PLANNING → DONE');
  });
});
