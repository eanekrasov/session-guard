import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import { setGateStatus } from '../../src/session/helpers.ts';
import { SessionGuardEngine } from '../../src/domain/engine.ts';
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
      { from: 'PLANNING', to: 'EXECUTION', guard: "session.approved('plan')" },
      // Раньше это были `kind: pass` и `kind: fail`, читавшие список гейтов с
      // уровня схемы. Сахар снят: ребро называет гейты само.
      { from: 'EXECUTION', to: 'COMMIT', guard: "session.gates.invariants == 'passed'" },
      { from: 'EXECUTION', to: 'FIXUP', guard: "session.gates.invariants == 'failed'" },
      { from: 'COMMIT', to: 'DONE' },
    ],
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

describe('E2E: checkTransition — engine.checkTransition integration', () => {
  test('engine.checkTransition without session refuses a conditional edge', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sm-e2e-no-session'));
    store = new WorkflowStore(join(directory, '.opencode/session-guard/sessions'));

    const engine = new SessionGuardEngine(makeConfig());
    const result = engine.checkTransition('EXECUTION', 'COMMIT');

    // Без сессии guard прочитать не на чём, а невычисленное условие — не
    // выполненное. Ребро отказывается, а не пропускается.
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot be checked without a session');
  });

  test('engine.checkTransition with a session reads the gate the edge names', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sm-e2e-inject'));
    store = new WorkflowStore(join(directory, '.opencode/session-guard/sessions'));
    const session = await createWorkflowSession('root', 'test');

    // invariants ещё pending — ребро закрыто
    await store.save(session);

    const engine = new SessionGuardEngine(makeConfig());
    const result = engine.checkTransition('EXECUTION', 'COMMIT', session);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('invariants');
  });

  test('illegal transition returns allowed: false', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sm-e2e-illegal'));
    store = new WorkflowStore(join(directory, '.opencode/session-guard/sessions'));

    const engine = new SessionGuardEngine(makeConfig());
    const result = engine.checkTransition('PLANNING', 'DONE');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Illegal stage transition: PLANNING → DONE');
  });
});
