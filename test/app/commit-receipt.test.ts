import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

let storeDirectory: string;
let profilesDirectory: string;
let repoDirectory: string;
let previousCwd: string;
let previousStoreDirectory: string | undefined;
let previousProfilesDirectory: string | undefined;

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoDirectory, encoding: 'utf-8' });
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

async function writeProfile(): Promise<void> {
  const profileDirectory = join(profilesDirectory, 'commit-receipt');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'commit-receipt', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'phases:',
      '  EXECUTION:',
      '    loop: implementation',
      '    stages:',
      '      - id: dev',
      "        allowedAgents: ['code']",
      'phaseAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );
}

/** Session holding a permit issued against the current HEAD. */
async function sessionWithPermit(expectedFiles: string[]): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'commit-receipt');
  session.deliveryPermit = {
    callID: 'commit-call',
    preCommitHead: git(['rev-parse', 'HEAD']),
    expectedFiles,
    startedAt: new Date().toISOString(),
  };
  await store.save(session);
  return store;
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

function commit(files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    spawnSync('sh', ['-c', `mkdir -p "$(dirname "${path}")" && cat > "${path}"`], {
      cwd: repoDirectory,
      input: content,
      encoding: 'utf-8',
    });
  }
  git(['add', '-A']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(async () => {
  previousCwd = process.cwd();
  previousStoreDirectory = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDirectory = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'commit-receipt-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'commit-receipt-profiles-'));
  repoDirectory = await mkdtemp(join(tmpdir(), 'commit-receipt-repo-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  await writeFile(join(repoDirectory, 'README.md'), 'seed\n', 'utf-8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
  process.chdir(repoDirectory);
  await writeProfile();
});

afterEach(async () => {
  process.chdir(previousCwd);
  if (previousStoreDirectory === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStoreDirectory;
  if (previousProfilesDirectory === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfilesDirectory;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
  await rm(repoDirectory, { recursive: true, force: true });
});

describe('handleCommitTaskAfter — receipt is written only against evidence', () => {
  it('records the receipt when the commit holds exactly the expected files', async () => {
    const store = await sessionWithPermit(['src/a.ts']);
    const hooks = await createRuntime(pluginInput());
    const head = commit({ 'src/a.ts': 'export const a = 1;\n' }, 'feat: a');

    const output = await afterBash(hooks);

    const session = await load(store);
    expect(session.deliveryReceipt).toBe(head);
    expect(session.deliveryPermit).toBeNull();
    expect(output).not.toContain('[workflow-commit-rejected]');
  });

  it('refuses the receipt when the commit contains an unexpected file', async () => {
    const store = await sessionWithPermit(['src/a.ts']);
    const hooks = await createRuntime(pluginInput());
    commit({ 'src/a.ts': 'export const a = 1;\n', 'secrets.txt': 'token\n' }, 'feat: a + junk');

    const output = await afterBash(hooks);

    const session = await load(store);
    expect(session.deliveryReceipt).toBeNull();
    expect(session.deliveryPermit).toBeNull();
    expect(output).toContain('[workflow-commit-rejected]');
    expect(output).toContain('secrets.txt');
  });

  it('refuses the receipt when the commit omits an expected file', async () => {
    const store = await sessionWithPermit(['src/a.ts', 'src/b.ts']);
    const hooks = await createRuntime(pluginInput());
    commit({ 'src/a.ts': 'export const a = 1;\n' }, 'feat: partial');

    const output = await afterBash(hooks);

    const session = await load(store);
    expect(session.deliveryReceipt).toBeNull();
    expect(session.deliveryPermit).toBeNull();
    expect(output).toContain('[workflow-commit-rejected]');
  });

  it('leaves the permit intact when HEAD did not move', async () => {
    const store = await sessionWithPermit(['src/a.ts']);
    const hooks = await createRuntime(pluginInput());

    const output = await afterBash(hooks);

    const session = await load(store);
    expect(session.deliveryReceipt).toBeNull();
    expect(session.deliveryPermit?.callID).toBe('commit-call');
    expect(output).not.toContain('[workflow-commit-rejected]');
  });

  it('ignores a commit made under a different callID', async () => {
    const store = await sessionWithPermit(['src/a.ts']);
    const hooks = await createRuntime(pluginInput());
    commit({ 'src/a.ts': 'export const a = 1;\n' }, 'feat: a');

    await afterBash(hooks, 'other-call');

    const session = await load(store);
    expect(session.deliveryReceipt).toBeNull();
    expect(session.deliveryPermit?.callID).toBe('commit-call');
  });
});
