import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

/**
 * task-movement-reporting spec: `blocked` and `unreachable`-on-pass
 * movements must surface a reason, spend no retry budget, and still clean
 * up the active operation.
 */

let storeDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;
const cleanupDirs: string[] = [];

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/test',
    worktree: '/tmp/test',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

let movementProfileId = 'movement-blocked';

function setMovementFixtureProfilesDir(profileId: string): void {
  setFixtureProfilesDir();
  movementProfileId = profileId;
}

async function seed(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', movementProfileId);
  session.tasks.implementation = [createTask()];
  await store.save(session);
  return store;
}

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'movement-store-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  rmSync(storeDirectory, { recursive: true, force: true });
  for (const directory of cleanupDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const dispatch = (hooks: Hooks, callID: string): Promise<void> =>
  hooks['tool.execute.before']!(
    { tool: 'task', sessionID: 's1', callID },
    { args: { subagent_type: 'code', description: '[workflow-task:task-1] implement' } }
  );

const report = (hooks: Hooks, callID: string, status: 'pass' | 'fail'): Promise<void> => {
  const tag = `<workflow-result>${JSON.stringify({
    stage: 'code',
    status,
    summary: 'ok',
    evidence: ['ok'],
  })}</workflow-result>`;
  return hooks['tool.execute.after']!(
    { tool: 'task', sessionID: 's1', callID, args: { subagent_type: 'code' } },
    { title: 'task', output: tag, metadata: {} }
  );
};

describe('a blocked movement surfaces its reason without spending budget', () => {
  it('records movement.reason and leaves the retry budget unchanged', async () => {
    setMovementFixtureProfilesDir('movement-blocked');
    const store = await seed();
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1');
    let session = await store.load('s1');
    expect(session?.activeOperations['call-1']).toBeDefined();
    const budgetBefore = session?.retryBudgets['task-1']?.attempts;

    const tag = `<workflow-result>${JSON.stringify({
      stage: 'code',
      status: 'pass',
      summary: 'ok',
      evidence: ['ok'],
    })}</workflow-result>`;
    const output = { title: 'task', output: tag, metadata: {} };
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1', args: { subagent_type: 'code' } },
      output
    );

    expect(output.output).toContain('[workflow-task-blocked]');

    session = await store.load('s1');
    // Cleanup still ran even though the movement was blocked.
    expect(session?.activeOperations).toEqual({});
    // No retry budget spent for a blocked movement.
    expect(session?.retryBudgets['task-1']?.attempts).toBe(budgetBefore);
    // The task did not move — a guard shut the only transition.
    expect(session?.tasks.implementation?.[0]?.status).not.toBe('completed');
  });
});

describe('an unreachable movement on a pass is reported', () => {
  it('records movement.reason as an observable outcome', async () => {
    // Declaration-order loop (no `transitions:`): nextTaskStage completes a
    // pass unless the run's own stage is not one of the loop's declared
    // stages — the only way `unreachable` happens on a pass. That is an
    // exhibit, not a natural flow: force it directly on the run after normal
    // admission, the way a corrupted or renamed stage would.
    setMovementFixtureProfilesDir('task-control');
    const store = await seed();
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1');

    const session = await store.load('s1');
    const run = session ? Object.values(session.loopRuns)[0] : undefined;
    expect(run).toBeDefined();
    run!.stage = 'no-such-stage';
    await store.save(session!);

    const output = { title: 'task', output: '', metadata: {} };
    output.output = `<workflow-result>${JSON.stringify({
      stage: 'no-such-stage',
      status: 'pass',
      summary: 'ok',
      evidence: ['ok'],
    })}</workflow-result>`;
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1', args: { subagent_type: 'code' } },
      output
    );

    expect(output.output).toContain('[workflow-task-unreachable]');

    const after = await store.load('s1');
    expect(after?.activeOperations).toEqual({});
    expect(after?.tasks.implementation?.[0]?.status).not.toBe('completed');
  });
});
