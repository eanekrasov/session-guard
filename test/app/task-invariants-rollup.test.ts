import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function writeProfile(): Promise<void> {
  const profileDirectory = join(profilesDirectory, 'rollup');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'rollup', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    dispatch:',
      '      strategy: serial',
      '    stages:',
      '      code:',
      "        allowedAgents: ['coder']",
      '    transitions:',
      '      - from: code',
      '        to: done',
      '        guard: "task.gates.invariants == \'passed\'"',
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );
}

async function seed(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'rollup');
  session.tasks.implementation = [createTask()];
  await store.save(session);
  return store;
}

let previousStore: string | undefined;

beforeEach(async () => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'invariants-rollup-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'invariants-rollup-profiles-'));
  gitDir = makeGitDir();
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  delete process.env.STATE_MACHINE_PROFILES_DIR;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
  await rm(gitDir, { recursive: true, force: true });
});

describe('run.gates.invariants rolls up before the movement it gates', () => {
  it('a task with no out-of-scope changes reaches done through a guard on task.gates.invariants', async () => {
    await writeProfile();
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

    let session = await store.load('s1');
    expect(session?.activeOperations['call-1']).toBeDefined();
    // The baseline frame was captured before admission (D2).
    expect(session?.activeOperations['call-1']?.baseline).toBeDefined();

    const tag = `<workflow-result>${JSON.stringify({ stage: 'code', status: 'pass', summary: 'ok', evidence: ['ok'] })}</workflow-result>`;
    const output = { title: 'task', output: tag, metadata: {} };
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1', args: { subagent_type: 'coder' } },
      output
    );

    session = await store.load('s1');
    // The operation is gone (cleanup follows recording, task-movement-reporting spec).
    expect(session?.activeOperations).toEqual({});
    // The task actually moved: the guard on task.gates.invariants only
    // passes when the roll-up ran before nextTaskStage evaluated it.
    const task = session?.tasks.implementation?.[0];
    expect(task?.status).toBe('completed');
  });
});

describe('a missing baseline frame leaves no gate (D5)', () => {
  it('never falls back to an empty baseline; the operation is still cleaned up', async () => {
    await writeProfile();
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

    const tag = `<workflow-result>${JSON.stringify({ stage: 'code', status: 'pass', summary: 'ok', evidence: ['ok'] })}</workflow-result>`;
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
async function writeParallelInvariantsProfile(): Promise<void> {
  const profileDirectory = join(profilesDirectory, 'nested-rollup');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'nested-rollup', schemas: ['cycle.yaml'], invariants: ['LF_ONLY'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'invariants.ts'),
    [
      'export const INVARIANTS = [',
      '  {',
      "    id: 'LF_ONLY',",
      "    severity: 'error',",
      "    check: (content) => (/\\r/u.test(content) ? 'CRLF detected — use LF line endings.' : null),",
      '  },',
      '];',
      '',
    ].join('\n'),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    dispatch:',
      '      strategy: parallel',
      '      maxConcurrent: 5',
      '    stages:',
      '      code:',
      "        allowedAgents: ['coder']",
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );
}

async function seedTwoTasks(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'nested-rollup');
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

describe('nested moves: an outer diff still reports a violation an inner pass skipped', () => {
  it('the inner move (a superset-excluding, later baseline) passes; the outer move (an older, superset baseline) fails on the same file', async () => {
    await writeParallelInvariantsProfile();
    const store = await seedTwoTasks();
    const hooks: Hooks = createRuntime(pluginInput());

    // Outer move begins first — its baseline is captured before the
    // violating file exists at all.
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 's1', callID: 'call-outer' },
      {
        args: {
          subagent_type: 'coder',
          description: '[workflow-task:task-1] outer',
          prompt: 'go',
        },
      }
    );
    const afterOuterBefore = await store.load('s1');
    const outerRunId = afterOuterBefore?.activeOperations['call-outer']?.runId;
    expect(outerRunId).toBeDefined();

    // A violation lands on disk while the outer move is still in flight —
    // e.g. a bash write outside anyone's writeScope.
    writeFileSync(join(gitDir, 'bad.ts'), 'const x = 1;\r\n', 'utf-8');

    // Inner move begins AFTER the violation exists: its own baseline
    // captures the dirty tree as-is, so the violating file is part of the
    // inner move's "before" state, not its diff.
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 's1', callID: 'call-inner' },
      {
        args: {
          subagent_type: 'coder',
          description: '[workflow-task:task-2] inner',
          prompt: 'go',
        },
      }
    );
    const afterInnerBefore = await store.load('s1');
    const innerRunId = afterInnerBefore?.activeOperations['call-inner']?.runId;
    expect(innerRunId).toBeDefined();
    expect(afterInnerBefore?.activeOperations['call-inner']?.baseline?.['bad.ts']).toBeDefined();

    // The inner move closes with no further changes since its own
    // baseline — it reports `passed`, skipping the violation entirely.
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-inner', args: { subagent_type: 'coder' } },
      { title: 'task', output: passResult(), metadata: {} }
    );
    const afterInner = await store.load('s1');
    expect(afterInner?.loopRuns[innerRunId!]?.gates.invariants).toBe('passed');

    // The outer move closes next. Its diff is computed against its OWN,
    // older baseline — which never saw `bad.ts` — so the same file the
    // inner move skipped still surfaces here, and the outer move fails.
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-outer', args: { subagent_type: 'coder' } },
      { title: 'task', output: passResult(), metadata: {} }
    );
    const afterOuter = await store.load('s1');
    expect(afterOuter?.loopRuns[outerRunId!]?.gates.invariants).toBe('failed');
  });
});

describe('session.gates stays a whole-body aggregate, untouched by the per-task roll-up', () => {
  it('does not write to session.gates when run.gates.invariants is rolled up', async () => {
    await writeProfile();
    const store = await seed();
    const hooks: Hooks = createRuntime(pluginInput());

    const before = await store.load('s1');
    const sessionGatesBefore = JSON.stringify(before?.gates);

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
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 's1', callID: 'call-1', args: { subagent_type: 'coder' } },
      { title: 'task', output: passResult(), metadata: {} }
    );

    const after = await store.load('s1');
    // The per-task roll-up only ever writes run.gates.invariants (D3); the
    // session-wide gates array is a separate, whole-body aggregate that
    // this change does not touch.
    expect(JSON.stringify(after?.gates)).toBe(sessionGatesBefore);
    const runId = Object.keys(after?.loopRuns ?? {})[0]!;
    expect(after?.loopRuns[runId]?.gates.invariants).toBe('passed');
  });
});
