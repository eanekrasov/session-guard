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

describe('a bash call that only reads', () => {
  it('is not refused for want of an approved plan or a runnable task', async () => {
    // `bash` is in mutatingTools because it usually mutates, so a read had to
    // satisfy a lifecycle built for writes: `git status --short` was refused
    // before the plan was approved, and refused afterwards with "Cannot
    // resolve a single workflow task run for mutation" whenever the session
    // had no runnable task.
    const store = new WorkflowStore(storeDirectory);
    // Fresh session: no plan approval, no tasks — both refusal paths armed.
    await store.save(createSession('read-only', 'base', 'state-machine'));
    const hooks = await createRuntime(pluginInput());

    for (const command of ['git status --short', 'ls -la', 'rg -n TODO src']) {
      await expect(
        hooks['tool.execute.before']!(
          { tool: 'bash', sessionID: 'read-only', callID: `call-${command}` },
          { args: { command } }
        )
      ).resolves.toBeUndefined();
    }

    const reloaded = await store.load('read-only');
    expect(reloaded?.activeOperations).toEqual({});
    expect(Object.values(reloaded?.loopRuns ?? {})).toHaveLength(0);
  });

  it('still refuses a write on the same session', async () => {
    const store = new WorkflowStore(storeDirectory);
    await store.save(createSession('read-only-guard', 'base', 'state-machine'));
    const hooks = await createRuntime(pluginInput());

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 'read-only-guard', callID: 'call-write' },
        { args: { command: 'npm run build' } }
      )
    ).rejects.toThrow();
  });
});

describe('what a dispatched task changed reaches the delivery permit', () => {
  it("records a task move's files, so the permit expects them", async () => {
    // `changedFiles` was written in exactly one place — inside finishMutation,
    // which runs only for bash/write/edit/apply_patch. A `task` dispatch never
    // reaches it, so a workflow whose work is entirely delegated (which is
    // what the shipped workflow does) arrived at `commit` with the list empty.
    // The permit is built from it, so it expected nothing, and the commit
    // carrying the work was refused: "Committed files do not match the
    // delivery permit. Expected: (none)".
    const { writeFile } = await import('node:fs/promises');
    const { approve } = await import('../../src/domain/approvals.ts');
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('delegated', 'base', 'state-machine', 'planning');
    // The stage is derived from the facts, not from what we write here: the
    // fixture's `uncommitted` rule needs an approved plan and an unfinished
    // task before it puts the session in `execution`.
    approve(session, 'plan', 'evidence', 'approve-call');
    session.currentStage = 'execution';
    session.tasks.implementation = [createTask({ status: 'pending' })];
    await store.save(session);

    const hooks = await createRuntime(pluginInput());

    // The orchestrator dispatches the task; the plugin snapshots the tree.
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 'delegated', callID: 'call-task' },
      { args: { subagent_type: 'code', description: '[workflow-task:task-1] build it' } }
    );

    // The subagent's work lands in the working tree.
    await writeFile(join(repoDirectory, 'delivered.ts'), 'export const built = true;\n', 'utf-8');

    await hooks['tool.execute.after']!(
      {
        tool: 'task',
        sessionID: 'delegated',
        callID: 'call-task',
        args: { subagent_type: 'code' },
      },
      { title: 'task', output: 'done', metadata: {} }
    );

    expect((await store.load('delegated'))?.changedFiles).toContain('delivered.ts');
  });
});

describe('a commit after an intermediate change was undone', () => {
  it('is receipted: the permit expects the net change, not everything touched', async () => {
    // changedFiles accumulated every path the work ever touched. Edit a.ts,
    // put it back, edit b.ts, commit only b.ts — and the permit still expected
    // both, so a correct commit was refused, deliveryReceipt stayed null and
    // the workflow sat in `commit`.
    const { writeFile, mkdir } = await import('node:fs/promises');
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('undone', 'base', 'state-machine', 'planning');
    session.currentStage = 'commit';
    session.tasks.implementation = [createTask({ status: 'completed' })];
    for (const gate of ['invariants', 'review', 'qa']) setGateStatus(session, gate, 'passed');

    await mkdir(join(repoDirectory, 'src'), { recursive: true });
    await writeFile(join(repoDirectory, 'src/a.ts'), 'export const a = 1;\n', 'utf-8');
    await writeFile(join(repoDirectory, 'src/b.ts'), 'export const b = 1;\n', 'utf-8');
    git(repoDirectory, ['add', '-A']);
    git(repoDirectory, ['commit', '-q', '-m', 'both files']);

    // The work touched a.ts, then put it back, and changed b.ts.
    session.changedFiles = ['src/a.ts', 'src/b.ts'];
    await store.save(session);
    await writeFile(join(repoDirectory, 'src/b.ts'), 'export const b = 2;\n', 'utf-8');

    const hooks = await createRuntime(pluginInput());
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 'undone', callID: 'commit-call' },
      { args: { command: 'bun run commit-task.ts -m "feat: b"' } }
    );

    // The permit expects what the tree actually differs by.
    expect((await store.load('undone'))?.deliveryPermit?.expectedFiles).toEqual(['src/b.ts']);

    git(repoDirectory, ['add', '-A']);
    git(repoDirectory, ['commit', '-q', '-m', 'feat: b']);
    // The local `git` helper returns void, so read HEAD directly.
    const head = (
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDirectory, encoding: 'utf-8' }).stdout ??
      ''
    ).trim();

    const output = { title: 'commit-task', output: 'commit-task: committed', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'bash',
        sessionID: 'undone',
        callID: 'commit-call',
        args: { command: 'bun run commit-task.ts -m "feat: b"' },
      },
      output
    );

    expect(output.output).not.toContain('[workflow-commit-rejected]');
    expect((await store.load('undone'))?.deliveryReceipt).toBe(head);
  });
});
