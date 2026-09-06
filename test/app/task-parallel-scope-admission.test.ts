import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { MutationTask } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

/**
 * task-scope spec: non-overlapping writeScope enables parallel admission;
 * an overlapping writeScope is rejected.
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

function setParallelProfilesDir(): void {
  process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
}

async function seed(taskA: Partial<MutationTask>, taskB: Partial<MutationTask>) {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'parallel-scope', 'cycle');
  session.tasks.implementation = [createTask(taskA), createTask({ id: 'task-2', ...taskB })];
  await store.save(session);
  return store;
}

function dispatch(hooks: Hooks, callID: string, taskId: string): Promise<void> {
  return hooks['tool.execute.before']!(
    { tool: 'task', sessionID: 's1', callID },
    { args: { subagent_type: 'code', description: `[workflow-task:${taskId}] work` } }
  );
}

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'parallel-scope-store-'));
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

describe('non-overlapping writeScope enables parallel admission', () => {
  it('admits a second task whose writeScope is disjoint from the running one', async () => {
    setParallelProfilesDir();
    await seed({ writeScope: ['src/auth/**'] }, { writeScope: ['src/billing/**'] });
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1', 'task-1');
    await expect(dispatch(hooks, 'call-2', 'task-2')).resolves.toBeUndefined();
  });

  it('rejects a second task whose writeScope overlaps the running one', async () => {
    setParallelProfilesDir();
    await seed({ writeScope: ['src/auth/**'] }, { writeScope: ['src/auth/login.ts'] });
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1', 'task-1');
    await expect(dispatch(hooks, 'call-2', 'task-2')).rejects.toThrow();
  });

  it('always admits a read-only task with no writeScope', async () => {
    setParallelProfilesDir();
    await seed({ writeScope: ['src/auth/**'] }, {});
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1', 'task-1');
    await expect(dispatch(hooks, 'call-2', 'task-2')).resolves.toBeUndefined();
  });
});

describe('a parallel scope-overlap refusal names the admissible task', () => {
  it('lists a pending task with a disjoint writeScope as admissible now', async () => {
    setParallelProfilesDir();
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('s1', 'parallel-scope', 'cycle');
    session.tasks.implementation = [
      createTask({ writeScope: ['src/auth/**'] }),
      createTask({ id: 'task-2', writeScope: ['src/auth/login.ts'] }),
      createTask({ id: 'task-3', writeScope: ['src/billing/**'] }),
    ];
    await store.save(session);
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1', 'task-1');
    await expect(dispatch(hooks, 'call-2', 'task-2')).rejects.toThrow(/admissible now: task-3/);
  });

  it('names no admissible task when every other pending task also overlaps', async () => {
    setParallelProfilesDir();
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('s1', 'parallel-scope', 'cycle');
    session.tasks.implementation = [
      createTask({ writeScope: ['src/auth/**'] }),
      createTask({ id: 'task-2', writeScope: ['src/auth/login.ts'] }),
    ];
    await store.save(session);
    const hooks: Hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-1', 'task-1');
    let message = '';
    try {
      await dispatch(hooks, 'call-2', 'task-2');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/writeScope overlaps/);
    expect(message).not.toMatch(/admissible now/);
  });
});
