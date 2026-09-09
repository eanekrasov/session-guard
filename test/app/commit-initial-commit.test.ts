import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

let storeDirectory: string;
let repoDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
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
  previousStore = process.env.SESSION_GUARD_STORE_DIR;
  previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'first-commit-store-'));
  repoDirectory = await mkdtemp(join(tmpdir(), 'first-commit-repo-'));
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  git(repoDirectory, ['init', '-q']);
  git(repoDirectory, ['config', 'user.email', 'test@example.com']);
  git(repoDirectory, ['config', 'user.name', 'test']);
  setFixtureProfilesDir();
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
  else process.env.SESSION_GUARD_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
  else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(repoDirectory, { recursive: true, force: true });
});

describe("the repository's very first commit", () => {
  it('is verified against the permit like any other', async () => {
    // `git diff-tree` compares a commit against its parent, and the initial
    // commit has none — so without `--root` it printed nothing, the empty list
    // was read as "cannot determine which files this commit contains", and a
    // correct first commit was rejected with the workflow stuck in `commit`.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('first-commit', 'cycle-minimal', 'cycle');
    session.deliveryPermit = {
      callID: 'commit-call',
      // No commit exists yet, so there is no HEAD to record.
      preCommitHead: 'unknown',
      expectedFiles: ['README.md', 'src/a.ts'],
      startedAt: new Date().toISOString(),
    };
    await store.save(session);

    await writeFile(join(repoDirectory, 'README.md'), 'seed\n', 'utf-8');
    await mkdir(join(repoDirectory, 'src'), { recursive: true });
    await writeFile(join(repoDirectory, 'src/a.ts'), 'export const a = 1;\n', 'utf-8');
    git(repoDirectory, ['add', '-A']);
    git(repoDirectory, ['commit', '-q', '-m', 'feat: the first commit']);
    const head = git(repoDirectory, ['rev-parse', 'HEAD']);

    const hooks: Hooks = createRuntime(pluginInput());
    const output = { title: 'commit-task', output: 'commit-task: committed', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'bash',
        sessionID: 'first-commit',
        callID: 'commit-call',
        args: { command: 'bun run commit-task.ts -m "feat: the first commit"' },
      },
      output
    );

    const reloaded = await store.load('first-commit');
    expect(output.output).not.toContain('[workflow-commit-rejected]');
    expect(reloaded?.deliveryReceipt).toBe(head);
    expect(reloaded?.deliveryPermit).toBeNull();
  });

  it('is still rejected when it contains a file the permit did not name', async () => {
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('first-commit-extra', 'cycle-minimal', 'cycle');
    session.deliveryPermit = {
      callID: 'commit-call',
      preCommitHead: 'unknown',
      expectedFiles: ['README.md'],
      startedAt: new Date().toISOString(),
    };
    await store.save(session);

    await writeFile(join(repoDirectory, 'README.md'), 'seed\n', 'utf-8');
    await writeFile(join(repoDirectory, 'secrets.txt'), 'token\n', 'utf-8');
    git(repoDirectory, ['add', '-A']);
    git(repoDirectory, ['commit', '-q', '-m', 'feat: first commit plus junk']);

    const hooks: Hooks = createRuntime(pluginInput());
    const output = { title: 'commit-task', output: 'commit-task: committed', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'bash',
        sessionID: 'first-commit-extra',
        callID: 'commit-call',
        args: { command: 'bun run commit-task.ts -m x' },
      },
      output
    );

    const reloaded = await store.load('first-commit-extra');
    expect(output.output).toContain('[workflow-commit-rejected]');
    expect(reloaded?.deliveryReceipt).toBeNull();
  });
});
