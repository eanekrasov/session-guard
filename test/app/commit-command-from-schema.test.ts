import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
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

async function runBash(hooks: Hooks, command: string): Promise<void> {
  await hooks['tool.execute.before']!(
    { tool: 'bash', sessionID: 's1', callID: 'c1' },
    { args: { command } }
  );
}

beforeEach(async () => {
  previousStoreDir = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDir = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'commit-schema-store-'));
  repoDirectory = await mkdtemp(join(tmpdir(), 'commit-schema-repo-'));
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

describe('the schema, not the core, says which command delivers a commit', () => {
  async function sessionOnCommit(): Promise<WorkflowStore> {
    const store = new WorkflowStore(storeDirectory);
    await store.save(createSession('s1', 'commit-declared', 'flow', 'commit'));
    return store;
  }

  it('issues a delivery permit for the command the schema declares', async () => {
    const store = await sessionOnCommit();
    const hooks = await createRuntime(pluginInput());

    // `deliver now` не содержит имени `commit-task.ts` — зашитый в ядро
    // классификатор его не узнал бы никогда.
    await runBash(hooks, 'deliver now');

    expect((await store.load('s1'))?.deliveryPermit?.callID).toBe('c1');
  });

  it('does not treat the core’s own commit-task shape as delivery once the schema declares its own', async () => {
    const store = await sessionOnCommit();
    const hooks = await createRuntime(pluginInput());

    // Эту форму ядро узнаёт, а профиль её не объявлял. Действие называет
    // инструмент, так что отказ говорит про `bash` — ровно то имя, которое
    // автор и написал, — и называет команду, которую ничто не покрыло.
    await expect(runBash(hooks, 'bun run commit-task.ts --Message m')).rejects.toThrow(
      /Refused: 'bash' is declared on this stage, but no entry covers/
    );
    expect((await store.load('s1'))?.deliveryPermit ?? null).toBeNull();
  });
  it('lets a profile deliver through plain git commit, which the core forbids by default', async () => {
    const store = new WorkflowStore(storeDirectory);
    await store.save(createSession('s1', 'commit-plain-git', 'flow', 'commit'));
    const hooks = await createRuntime(pluginInput());

    // Дефолт ядра запрещает прямой `git commit`. Стадия объявила действия,
    // значит отвечает она — и объявила именно эту форму доставки.
    await runBash(hooks, 'git commit -m "delivered"');

    expect((await store.load('s1'))?.deliveryPermit?.callID).toBe('c1');
  });

  it('still forbids plain git commit where the stage declares nothing', async () => {
    const store = new WorkflowStore(storeDirectory);
    await store.save(createSession('s1', 'cycle-minimal', 'cycle', 'execution'));
    const hooks = await createRuntime(pluginInput());

    await expect(runBash(hooks, 'git commit -m "sneaky"')).rejects.toThrow(
      /git commit\/push is blocked/
    );
    expect((await store.load('s1'))?.deliveryPermit ?? null).toBeNull();
  });
});

describe('the first edit of a task is judged by the stage its run will open on', () => {
  async function editOnExecution(approved: boolean): Promise<{ threw: boolean; message: string }> {
    // Настоящий `base`, а не фикстура: проверяется поведение shipped-профиля.
    process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '../../profiles');
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('s1', 'base', 'base', 'execution');
    session.tasks = { implementation: [{ id: 'task-1', title: 't', status: 'pending' }] };
    if (approved) {
      session.approvals = [
        { type: 'plan', callId: 'c', status: 'granted', grantedAt: new Date().toISOString() },
      ];
    }
    await store.save(session);
    const hooks = await createRuntime(pluginInput());
    try {
      await hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 's1', callID: 'c1' },
        { args: { filePath: join(repoDirectory, 'src/a.ts'), content: 'x' } }
      );
      return { threw: false, message: '' };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  it('admits it once the plan is approved, though no run is open yet', async () => {
    // `beginMutation` открывает прогон ПОСЛЕ допуска действия. Судить первую
    // правку по внешней стадии цикла — значит не дать работе начаться вообще:
    // ровно это и сломало host-smoke.
    const result = await editOnExecution(true);
    expect(result.message).toBe('');
    expect(result.threw).toBe(false);
  });

  it('refuses it by the plan guard, not by «the stage declares no edit»', async () => {
    const result = await editOnExecution(false);
    expect(result.threw).toBe(true);
    expect(result.message).toContain('condition does not hold');
    expect(result.message).not.toContain('does not declare the action');
  });
});
