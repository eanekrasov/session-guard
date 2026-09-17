import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask, createTasks } from '../support/task-factory.ts';

/**
 * Regression guard for design.md D3 (move-invariants) and the two orderings
 * called out in tasks.md 3.5/3.6 and 3.7/3.8:
 *
 * 1. `invariantsAfter` (step 1a) MUST run before `handleWorkflowResult`
 *    (step 1b) — it writes `operation.invariants` before the operation is
 *    read/deleted.
 * 2. The `run.gates.invariants` roll-up MUST happen before the
 *    `failed || passed` movement block, so a loop edge guarded on
 *    `task.gates.invariants == 'passed'` actually gates the movement.
 *
 * If either ordering regresses, the guard below never sees a 'passed'
 * value and the task never reaches `done`.
 */

let storeDirectory: string;
let profilesDirectory: string;
let gitDir: string;

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: gitDir,
      worktree: gitDir,
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: gitDir,
    worktree: gitDir,
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

function makeGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invariants-rollup-git-'));
  execSync('git init', { cwd: dir, encoding: 'utf-8' });
  execSync('git config user.email test@test.com && git config user.name test', {
    cwd: dir,
    encoding: 'utf-8',
  });
  writeFileSync(join(dir, 'init.ts'), 'const x = 1;\n', 'utf-8');
  execSync('git add -A && git commit -m init', { cwd: dir, encoding: 'utf-8' });
  return dir;
}

function setFixtureProfilesDir(): void {
  process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
}

async function seed(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'rollup', 'cycle');
  session.tasks.implementation = [createTask()];
  await store.save(session);
  return store;
}

let previousStore: string | undefined;

beforeEach(async () => {
  previousStore = process.env.SESSION_GUARD_STORE_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'invariants-rollup-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'invariants-rollup-profiles-'));
  gitDir = makeGitDir();
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  process.env.SESSION_GUARD_PROFILES_DIR = profilesDirectory;
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
  else process.env.SESSION_GUARD_STORE_DIR = previousStore;
  delete process.env.SESSION_GUARD_PROFILES_DIR;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
  await rm(gitDir, { recursive: true, force: true });
});

describe('a missing baseline frame leaves no gate (D5)', () => {
  it('never falls back to an empty baseline; the operation is still cleaned up', async () => {
    setFixtureProfilesDir();
    const store = await seed();
    const hooks: Hooks = createRuntime(pluginInput());

    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'coder',
          description: '[workflow-task:task-1] implement',
          prompt: 'go',
        },
      }
    );

    // Simulate a missing frame — e.g. admission ran before a projectDir was
    // available — by clearing the captured baseline directly.
    const before = await store.load('s1');
    if (before?.activeOperations['call-1']) {
      delete before.activeOperations['call-1'].baseline;
      await store.save(before);
    }

    const tag = `<workflow-result>${JSON.stringify({ gate: 'code', status: 'pass', summary: 'ok', evidence: ['ok'] })}</workflow-result>`;
    const output = { title: 'task', output: tag, metadata: {} };
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1', args: { subagent_type: 'coder' } },
      output
    );

    const session = await store.load('s1');
    expect(session?.activeOperations).toEqual({});
    // No frame means no gate was ever written, so the guard on
    // task.gates.invariants never holds and the task cannot reach done.
    const task = session?.tasks.implementation?.[0];
    expect(task?.status).not.toBe('completed');
  });
});

/**
 * move-invariants: "Baseline frames nest without losing violations" (design
 * central guarantee, tasks 3.11/3.12).
 *
 * Frames are absolute snapshots, so an outer move's baseline (captured
 * before an inner move even starts) already excludes anything the inner
 * move's OWN baseline picks up as "pre-existing" — an inner `pass` cannot
 * make a violation disappear from the outer move's diff, because the outer
 * diff is computed independently against the outer's own, older frame.
 */
function setNestedRollupFixtureProfilesDir(): void {
  process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
}

async function seedTwoTasks(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'nested-rollup', 'cycle');
  session.tasks.implementation = createTasks({}, {});
  await store.save(session);
  return store;
}

function passResult(): string {
  return `<workflow-result>${JSON.stringify({
    stage: 'code',
    status: 'pass',
    summary: 'ok',
    evidence: ['ok'],
  })}</workflow-result>`;
}

describe('the core’s verdict about a task move reaches the run', () => {
  async function runTaskMove(dirty: string): Promise<WorkflowStore> {
    setFixtureProfilesDir();
    const store = await seed();
    const hooks: Hooks = createRuntime(pluginInput());

    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'coder',
          description: '[workflow-task:task-1] implement',
          prompt: 'go',
        },
      }
    );

    // Ход субагента: файл появляется между baseline и after-хуком.
    writeFileSync(join(gitDir, 'touched.ts'), dirty, 'utf-8');

    const tag = `<workflow-result>${JSON.stringify({ gate: 'code', status: 'pass', summary: 'ok', evidence: ['ok'] })}</workflow-result>`;
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1', args: { subagent_type: 'coder' } },
      { title: 'task', output: tag, metadata: {} }
    );
    return store;
  }

  it('records a clean move as passed and lets the task finish', async () => {
    const store = await runTaskMove('export const ok = 1;\n');
    const session = await store.load('s1');
    expect(session?.loopRuns['run-1']?.checks).toBe('passed');
  });

  it('records a move that breaks an invariant as failed, and the guard holds the task', async () => {
    // Профиль `rollup` объявляет инвариант LF_ONLY; CRLF его нарушает.
    const store = await runTaskMove('const bad = 1;\r\n');
    const session = await store.load('s1');
    expect(session?.loopRuns['run-1']?.checks).toBe('failed');
    expect(session?.tasks.implementation?.[0]?.status).not.toBe('completed');
  });
});
