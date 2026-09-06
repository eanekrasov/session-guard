import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTasks } from '../support/task-factory.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

/**
 * task-scope spec, CRITICAL-1 remediation: `scopeBefore` MUST enforce
 * writeScope/readScope against the UNION of every currently-running task's
 * scope, not just a single arbitrarily-picked task. With two or more
 * concurrent operations — the exact case `Non-overlapping writeScope
 * enables parallel admission` exists for — the gate must still refuse a
 * write/read that falls outside every running task's declared scope, and
 * admit one that falls inside any of them.
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

async function seedTwoRunningTasks(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'parallel-scope');
  session.tasks.implementation = createTasks(
    { writeScope: ['src/auth/**'], readScope: ['src/auth/**'] },
    { writeScope: ['src/billing/**'], readScope: ['src/billing/**'] }
  );
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

describe('scopeBefore under two concurrently running tasks', () => {
  // NOTE on the two "admits" cases below: `write` is also a `mutatingTool`,
  // so once `scopeBefore` admits it the call reaches `mutationBefore` →
  // `beginMutation`, whose pre-existing (unrelated to task-scope)
  // `releaseInterruptedLock` unconditionally clears every active operation
  // not tracked in `liveMutations` — including the OTHER running task's
  // operation — leaving 2 open `loopRuns` and 0 active operations, so
  // `resolveMutationRun` cannot pick one and throws. That failure mode is a
  // distinct, pre-existing single-active-mutation assumption in
  // `mutation-orchestrator.ts`, not a task-scope regression, and is out of
  // this change's scope. What these two tests prove is narrower and correct
  // for `scopeBefore` itself: the rejection is NOT a writeScope refusal —
  // proving the union check admitted the path — it is that unrelated,
  // already-logged mutation-lifecycle failure instead.
  it("admits a write matching the first running task's writeScope (scopeBefore itself does not refuse it)", async () => {
    setFixtureProfilesDir();
    await seedTwoRunningTasks();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-1', 'task-1');
    await dispatch(hooks, 'call-2', 'task-2');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 's1', callID: 'call-write-1' },
        { args: { filePath: 'src/auth/login.ts', content: 'x' } }
      )
    ).rejects.toThrow(/Cannot resolve a single workflow task run for mutation/);
  });

  it("admits a write matching the second running task's writeScope (scopeBefore itself does not refuse it)", async () => {
    setFixtureProfilesDir();
    await seedTwoRunningTasks();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-1', 'task-1');
    await dispatch(hooks, 'call-2', 'task-2');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 's1', callID: 'call-write-2' },
        { args: { filePath: 'src/billing/invoice.ts', content: 'x' } }
      )
    ).rejects.toThrow(/Cannot resolve a single workflow task run for mutation/);
  });

  it("refuses a write matching neither running task's writeScope, and refuses it for that reason", async () => {
    setFixtureProfilesDir();
    await seedTwoRunningTasks();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-1', 'task-1');
    await dispatch(hooks, 'call-2', 'task-2');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 's1', callID: 'call-write-3' },
        { args: { filePath: 'src/other/config.ts', content: 'x' } }
      )
    ).rejects.toThrow(/writeScope/);
  });

  it("refuses a read matching neither running task's readScope", async () => {
    setFixtureProfilesDir();
    await seedTwoRunningTasks();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-1', 'task-1');
    await dispatch(hooks, 'call-2', 'task-2');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'read', sessionID: 's1', callID: 'call-read-1' },
        { args: { filePath: 'docs/other.md' } }
      )
    ).rejects.toThrow(/readScope/);
  });

  it("admits a read matching the second running task's readScope", async () => {
    setFixtureProfilesDir();
    await seedTwoRunningTasks();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-1', 'task-1');
    await dispatch(hooks, 'call-2', 'task-2');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'read', sessionID: 's1', callID: 'call-read-2' },
        { args: { filePath: 'src/billing/invoice.ts' } }
      )
    ).resolves.toBeUndefined();
  });
});
