import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

let storeDirectory: string;
let profilesDirectory: string;
let repoDirectory: string;
let otherRepo: string;
let previousCwd: string;
let previousStoreDir: string | undefined;
let previousProfilesDir: string | undefined;

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

async function sessionWithPermit(expectedFiles: string[]): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'cycle-minimal', 'cycle');
  session.deliveryPermit = {
    callID: 'commit-call',
    preCommitHead: git(repoDirectory, ['rev-parse', 'HEAD']),
    expectedFiles,
    startedAt: new Date().toISOString(),
  };
  await store.save(session);
  return store;
}

function commit(files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    spawnSync('sh', ['-c', `mkdir -p "$(dirname "${path}")" && cat > "${path}"`], {
      cwd: repoDirectory,
      input: content,
      encoding: 'utf-8',
    });
  }
  git(repoDirectory, ['add', '-A']);
  git(repoDirectory, ['commit', '-m', message]);
  return git(repoDirectory, ['rev-parse', 'HEAD']);
}

async function afterBash(hooks: Hooks, callID = 'commit-call'): Promise<string> {
  const output = { title: 'commit-task', output: 'commit-task: committed', metadata: {} };
  await hooks['tool.execute.after']!(
    { tool: 'bash', sessionID: 's1', callID, args: { command: 'bun run commit-task.ts -m "x"' } },
    output
  );
  return output.output;
}

async function load(store: WorkflowStore): Promise<WorkflowSession> {
  const session = await store.load('s1');
  if (!session) throw new Error('test session was not persisted');
  return session;
}

beforeEach(async () => {
  previousCwd = process.cwd();
  previousStoreDir = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDir = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'commit-cwd-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'commit-cwd-profiles-'));
  repoDirectory = await mkdtemp(join(tmpdir(), 'commit-cwd-repo-'));
  otherRepo = await mkdtemp(join(tmpdir(), 'commit-cwd-other-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;

  // Инициализируем основной репозиторий проекта
  git(repoDirectory, ['init', '-q']);
  git(repoDirectory, ['config', 'user.email', 'test@example.com']);
  git(repoDirectory, ['config', 'user.name', 'test']);
  await writeFile(join(repoDirectory, 'README.md'), 'seed\n', 'utf-8');
  git(repoDirectory, ['add', '-A']);
  git(repoDirectory, ['commit', '-q', '-m', 'seed']);
  setFixtureProfilesDir();

  // Инициализируем другой репозиторий — никак не связанный с проектом
  git(otherRepo, ['init', '-q']);
  git(otherRepo, ['config', 'user.email', 'other@example.com']);
  git(otherRepo, ['config', 'user.name', 'other']);
  await writeFile(join(otherRepo, 'other.md'), 'other\n', 'utf-8');
  git(otherRepo, ['add', '-A']);
  git(otherRepo, ['commit', '-q', '-m', 'other']);

  // Ключевой момент: process.cwd() указывает на otherRepo, а context.directory — на repoDirectory
  process.chdir(otherRepo);
});

afterEach(async () => {
  process.chdir(previousCwd);
  if (previousStoreDir === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStoreDir;
  if (previousProfilesDir === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfilesDir;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
  await rm(repoDirectory, { recursive: true, force: true });
  await rm(otherRepo, { recursive: true, force: true });
});

describe('Git cwd isolation — process.cwd differs from project directory', () => {
  it('getPreCommitHead читает HEAD проекта, а не process.cwd', async () => {
    const repoHead = git(repoDirectory, ['rev-parse', 'HEAD']);
    const otherHead = git(otherRepo, ['rev-parse', 'HEAD']);
    expect(repoHead).not.toBe(otherHead); // precondition

    const store = await sessionWithPermit([]);
    const hooks = await createRuntime(pluginInput());

    // HEAD не менялся — permit не сбросится
    const output = await afterBash(hooks);

    const session = await load(store);
    // Без cwd в getPreCommitHead() здесь был бы null (otherHead не совпал бы с repoHead)
    expect(session.deliveryPermit).not.toBeNull();
    expect(session.deliveryPermit!.preCommitHead).toBe(repoHead);
    expect(session.deliveryReceipt).toBeNull();
    expect(output).not.toContain('[workflow-commit-rejected]');
  });

  it('handleCommitTaskAfter верифицирует HEAD проекта', async () => {
    const store = await sessionWithPermit(['src/a.ts']);
    const hooks = await createRuntime(pluginInput());
    const head = commit({ 'src/a.ts': 'export const a = 1;\n' }, 'feat: a');

    const output = await afterBash(hooks);

    const session = await load(store);
    // Без cwd currentHead прочитал бы otherRepo HEAD — receipt бы не записался
    expect(session.deliveryReceipt).toBe(head);
    expect(session.deliveryPermit).toBeNull();
    expect(output).not.toContain('[workflow-commit-rejected]');
  });

  it('блокирует receipt при несовпадении файлов (даже с другим cwd)', async () => {
    const store = await sessionWithPermit(['src/a.ts']);
    const hooks = await createRuntime(pluginInput());
    commit({ 'src/a.ts': 'export const a = 1;\n', 'secrets.txt': 'token\n' }, 'feat: a + junk');

    const output = await afterBash(hooks);

    const session = await load(store);
    expect(session.deliveryReceipt).toBeNull();
    expect(session.deliveryPermit).toBeNull();
    expect(output).toContain('[workflow-commit-rejected]');
  });
});
