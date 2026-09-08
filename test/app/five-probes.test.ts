import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

let storeDirectory: string;
let projectDirectory: string;
let outsideDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: projectDirectory,
      worktree: projectDirectory,
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: projectDirectory,
    worktree: projectDirectory,
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'probe-store-'));
  projectDirectory = mkdtempSync(join(tmpdir(), 'probe-project-'));
  outsideDirectory = mkdtempSync(join(tmpdir(), 'probe-outside-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  setFixtureProfilesDir();
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  for (const dir of [storeDirectory, projectDirectory, outsideDirectory]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('a symlink is not a way out of the project', () => {
  it('refuses a write whose real target is outside, however the path reads', async () => {
    // `resolve` is lexical. `allowed/link.ts` kept a project-shaped path while
    // pointing anywhere, so the before-hook admitted it, the file outside was
    // rewritten, and the after-hook recorded `invariants: passed` about work
    // it had never seen.
    const outside = join(outsideDirectory, 'secret.ts');
    writeFileSync(outside, 'export const secret = 1;\n', 'utf-8');
    mkdirSync(join(projectDirectory, 'allowed'), { recursive: true });
    symlinkSync(outside, join(projectDirectory, 'allowed/link.ts'));

    const store = new WorkflowStore(storeDirectory);
    const session = createSession('symlink', 'parallel-scope', 'cycle', 'planning');
    session.tasks.implementation = [
      createTask({ id: 'task-1', status: 'pending', writeScope: ['allowed/**'] }),
    ];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 'symlink', callID: 'call-task' },
      { args: { subagent_type: 'code', description: '[workflow-task:task-1] work' } }
    );

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 'symlink', callID: 'call-write' },
        { args: { filePath: 'allowed/link.ts' } }
      )
    ).rejects.toThrow(/writeScope/);

    // Untouched.
    expect(readFileSync(outside, 'utf-8')).toBe('export const secret = 1;\n');
  });

  it('still admits a real file inside the scope', async () => {
    mkdirSync(join(projectDirectory, 'allowed'), { recursive: true });
    writeFileSync(join(projectDirectory, 'allowed/real.ts'), 'export const a = 1;\n', 'utf-8');

    const store = new WorkflowStore(storeDirectory);
    const session = createSession('inside', 'parallel-scope', 'cycle', 'planning');
    session.tasks.implementation = [
      createTask({ id: 'task-1', status: 'pending', writeScope: ['allowed/**'] }),
    ];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 'inside', callID: 'call-task' },
      { args: { subagent_type: 'code', description: '[workflow-task:task-1] work' } }
    );

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 'inside', callID: 'call-write' },
        { args: { filePath: 'allowed/real.ts' } }
      )
    ).resolves.toBeUndefined();
  });
});

describe('an invariant sees the file whatever it is called', () => {
  it('raises the same violation in .tsx as in .ts', async () => {
    // Identical CRLF raised LF_ONLY in `.ts` and reported `checked: 0` for
    // `.tsx`: a general rule about text has no business caring about JSX.
    const { validateFiles } = await import('../../src/app/invariants.ts');
    const { INVARIANTS } = await import('../../profiles/base/invariants.ts');

    const crlf = 'export const a = 1;\r\n';
    writeFileSync(join(projectDirectory, 'a.ts'), crlf, 'utf-8');
    writeFileSync(join(projectDirectory, 'a.tsx'), crlf, 'utf-8');

    const ts = validateFiles([join(projectDirectory, 'a.ts')], INVARIANTS, projectDirectory);
    const tsx = validateFiles([join(projectDirectory, 'a.tsx')], INVARIANTS, projectDirectory);

    expect(ts.errors.map((e) => e.invariant)).toContain('LF_ONLY');
    expect(tsx.checked).toBe(ts.checked);
    expect(tsx.errors.map((e) => e.invariant)).toEqual(ts.errors.map((e) => e.invariant));
  });
});

describe('reading tasks changes nothing', () => {
  it('leaves the revision where it was', async () => {
    // getTasks went through runInQueue, and both of that helper's paths save
    // unconditionally, so a single read bumped the revision — a version nobody
    // asked for, and a conflict waiting for a second writer.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('reader', 'base', 'state-machine', 'planning');
    session.tasks.implementation = [createTask()];
    await store.save(session);
    const before = (await store.load('reader'))!.revision;

    const hooks = createRuntime(pluginInput()) as Hooks & {
      tool?: Record<string, { execute: (a: unknown, c: unknown) => Promise<{ output: string }> }>;
    };
    await hooks.tool!['workflow-tasks-get']!.execute(
      { listKey: 'implementation' },
      { sessionID: 'reader' }
    );

    expect((await store.load('reader'))?.revision).toBe(before);
  });
});

describe('a guard is evaluated with the context it was given', () => {
  it('answers the same through the engine as it does directly', async () => {
    // The engine's adapter replaced the evaluation context with `{}`, so
    // `allTasksCompleted()` with no argument lost `currentLoopListKey` and
    // answered `false` where a direct evaluation answered `true`.
    const { GuardEvaluator } = await import('../../src/schema/guard-evaluator.ts');
    const { StateMachineEngine, toGuardContext } = await import('../../src/domain/engine.ts');
    const { MutationOrchestrator } = await import('../../src/app/mutation-orchestrator.ts');
    const { SessionExecutor } = await import('../../src/app/session-executor.ts');
    const { fixtureProfilesDir } = await import('../support/fixture-profiles.ts');

    const store = new WorkflowStore(storeDirectory);
    const session = createSession('ctx', 'jobs-loop', 'flow', 'planning');
    session.tasks.jobs = [createTask({ status: 'completed' })];
    await store.save(session);

    const context = { currentLoopListKey: 'jobs' };
    const facts = toGuardContext(session) as unknown as Record<string, unknown>;
    const direct = new GuardEvaluator(facts, undefined, context).evaluate('allTasksCompleted()');
    expect(direct).toBe(true);

    const orchestrator = new MutationOrchestrator(
      store,
      new SessionExecutor(store),
      projectDirectory,
      fixtureProfilesDir('profiles')
    );
    const engine: InstanceType<typeof StateMachineEngine> = await orchestrator.resolveEngine(
      'jobs-loop',
      'flow'
    );

    expect(engine.evaluateGuard('allTasksCompleted()', facts, context)).toBe(direct);
  });
});

describe('a task is judged by the checks the core ran on its own move', () => {
  it('does not leave `code` when this task’s move failed its checks', async () => {
    // `task.checks` — вердикт ядра о последнем ходе ЭТОЙ задачи. Он не гейт
    // именно поэтому: гейты пишет агент, и объявленный стадией гейт он может
    // выставить себе сам. Вердикт, снятый с диска, подделать нечем.
    const { nextTaskStage } = await import('../../src/domain/task-movement.ts');
    const { resolveConfig } = await import('../../src/public-api.ts');
    const { join: joinPath } = await import('node:path');

    const profile = await resolveConfig('base', joinPath(import.meta.dirname, '../../profiles'));
    const schema = profile.schemas.find((entry) => entry.id === 'base')!;
    const execution = schema.stages!.execution!;

    const run = {
      id: 'run-1',
      taskId: 'task-1',
      listKey: 'implementation',
      ancestry: [],
      stage: 'code',
      status: 'running' as const,
      gates: {},
      checks: 'failed' as const,
      round: 0,
    };

    const { GuardEvaluator } = await import('../../src/schema/guard-evaluator.ts');
    const evaluate = (expression: string, task: unknown): boolean =>
      new GuardEvaluator({ task } as unknown as Record<string, unknown>).evaluate(expression);

    expect(nextTaskStage(execution, run, true, evaluate).kind).not.toBe('move');

    // И проходит, когда её собственный ход вышел чистым.
    const passing = { ...run, checks: 'passed' as const };
    expect(nextTaskStage(execution, passing, true, evaluate).kind).toBe('move');
  });
});
