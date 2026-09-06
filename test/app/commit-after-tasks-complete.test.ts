import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { setGateStatus } from '../../src/session/helpers.ts';
import { createTask } from '../support/task-factory.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

let storeDirectory: string;
let repoDirectory: string;
let previousStoreDir: string | undefined;
let previousProfilesDir: string | undefined;

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: repoDirectory,
      worktree: repoDirectory,
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: repoDirectory,
    worktree: repoDirectory,
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

beforeEach(async () => {
  previousStoreDir = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDir = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'commit-done-store-'));
  repoDirectory = await mkdtemp(join(tmpdir(), 'commit-done-repo-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  git(repoDirectory, ['init', '-q']);
  git(repoDirectory, ['config', 'user.email', 'test@example.com']);
  git(repoDirectory, ['config', 'user.name', 'test']);
  await writeFile(join(repoDirectory, 'README.md'), 'seed\n', 'utf-8');
  git(repoDirectory, ['add', '-A']);
  git(repoDirectory, ['commit', '-q', '-m', 'seed']);
  setFixtureProfilesDir();
});

afterEach(async () => {
  if (previousStoreDir === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStoreDir;
  if (previousProfilesDir === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfilesDir;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(repoDirectory, { recursive: true, force: true });
});

describe('the commit step on a session whose work is finished', () => {
  it('issues a permit instead of demanding an unfinished task', async () => {
    // The commit stage is reached exactly because every task and run is
    // finished. The generic mutation lifecycle then demanded one open run or
    // one runnable task and refused the commit with "Cannot resolve a single
    // workflow task run for mutation": the commit required completed tasks,
    // and the handler behind it required an unfinished one.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('commit-done', 'base', 'state-machine');
    session.currentStage = 'commit';
    session.tasks.implementation = [createTask({ status: 'completed' })];
    for (const gate of ['invariants', 'review', 'qa']) setGateStatus(session, gate, 'passed');
    await store.save(session);

    const hooks = await createRuntime(pluginInput());

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 'commit-done', callID: 'commit-call' },
        { args: { command: 'bun run commit-task.ts -m "feat: x"' } }
      )
    ).resolves.toBeUndefined();

    const reloaded = await store.load('commit-done');
    expect(reloaded?.deliveryPermit?.callID).toBe('commit-call');
    // No task run was invented to carry the commit.
    expect(reloaded?.activeOperations).toEqual({});
    expect(Object.values(reloaded?.loopRuns ?? {})).toHaveLength(0);
  });
});
