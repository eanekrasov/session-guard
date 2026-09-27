import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';

/**
 * A successful mutation must finish.
 *
 * `tool.execute.before` begins the mutation, `tool.execute.after` must finish
 * it: compute the change scope, run the invariants, write the verdict and
 * delete the active operation. The `after` call was dropped when the execution
 * policy was introduced, so a successful `write` recorded no verdict and kept
 * its lock — the next mutation was refused with `Active operation already
 * exists` until the 30-minute TTL expired, and `host-smoke` could not pass its
 * commit scenarios at all. Unit tests missed it because they only covered the
 * *before* refusal and no-op finalization cases.
 */

let storeDirectory: string;
let gitDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;
const cleanupDirs: string[] = [];

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: gitDirectory,
      worktree: gitDirectory,
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: gitDirectory,
    worktree: gitDirectory,
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

/** A real repository: the change scope is computed against git. */
function makeGitDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mutation-after-git-'));
  cleanupDirs.push(directory);
  execSync('git init', { cwd: directory, encoding: 'utf-8' });
  execSync('git config user.email test@test.com && git config user.name test', {
    cwd: directory,
    encoding: 'utf-8',
  });
  writeFileSync(join(directory, 'init.ts'), 'const x = 1;\n', 'utf-8');
  execSync('git add -A && git commit -m init', { cwd: directory, encoding: 'utf-8' });
  return directory;
}

async function seedSession(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'scope-enforce', 'cycle');
  session.tasks.implementation = [createTask({ writeScope: ['src/auth/**'] })];
  await store.save(session);
  return store;
}

/** Dispatch the task, so one running task owns the writeScope. */
async function dispatchTask(hooks: Hooks, callID: string): Promise<void> {
  await hooks['tool.execute.before']!(
    { tool: 'task', sessionID: 's1', callID },
    { args: { subagent_type: 'code', description: '[workflow-task:task-1] implement' } }
  );
}

async function writeFile(
  hooks: Hooks,
  callID: string,
  filePath = 'src/auth/login.ts'
): Promise<void> {
  await hooks['tool.execute.before']!(
    { tool: 'write', sessionID: 's1', callID },
    { args: { filePath, content: 'export const login = 1;\n' } }
  );
  const absolute = join(gitDirectory, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, 'export const login = 1;\n', 'utf-8');
  await hooks['tool.execute.after']!(
    { tool: 'write', sessionID: 's1', callID, args: { filePath } },
    { title: 'write', output: 'ok', metadata: {} }
  );
}

beforeEach(() => {
  previousStore = process.env.SESSION_GUARD_STORE_DIR;
  previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'mutation-after-store-'));
  gitDirectory = makeGitDirectory();
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
  else process.env.SESSION_GUARD_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
  else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
  for (const directory of cleanupDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('a successful mutation is finished by the after hook', () => {
  it('records a verdict and releases the active operation', async () => {
    const store = await seedSession();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 'call-task');

    await hooks['tool.execute.before']!(
      { tool: 'write', sessionID: 's1', callID: 'call-write' },
      { args: { filePath: 'src/auth/login.ts', content: 'export const login = 1;\n' } }
    );
    const opened = await store.load('s1');
    expect(opened?.activeOperations['call-write']?.kind).toBe('mutation');

    mkdirSync(join(gitDirectory, 'src', 'auth'), { recursive: true });
    writeFileSync(
      join(gitDirectory, 'src', 'auth', 'login.ts'),
      'export const login = 1;\n',
      'utf-8'
    );

    await hooks['tool.execute.after']!(
      {
        tool: 'write',
        sessionID: 's1',
        callID: 'call-write',
        args: { filePath: 'src/auth/login.ts' },
      },
      { title: 'write', output: 'ok', metadata: {} }
    );

    const session = await store.load('s1');
    expect(session?.activeOperations['call-write']).toBeUndefined();

    // Внутри цикла вердикт адресован прогону задачи, вне цикла — сессии.
    const verdicts = [
      ...Object.values(session?.loopRuns ?? {}).map((run) => run.checks),
      session?.checks,
    ];
    expect(verdicts).toContain('passed');
    expect(session?.changedFiles ?? []).toContain('src/auth/login.ts');
  });

  it('admits the next mutation instead of refusing it as already active', async () => {
    await seedSession();
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 'call-task');

    await writeFile(hooks, 'call-write-1');

    await expect(writeFile(hooks, 'call-write-2', 'src/auth/session.ts')).resolves.toBeUndefined();
  });
});
