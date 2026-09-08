import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';
import { fixtureProfilesDir, setFixtureProfilesDir } from '../support/fixture-profiles.ts';

let storeDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/test',
    worktree: '/tmp/test',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

type ToolMap = Record<
  string,
  { execute: (_a: unknown, _c: unknown) => Promise<{ output: string }> }
>;

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'four-probe-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  setFixtureProfilesDir();
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  rmSync(storeDirectory, { recursive: true, force: true });
});

describe('cancelling a task ends the work on it', () => {
  it('closes the run and the call, so a late result cannot revive it', async () => {
    // Cancelling only wrote the task's own status. The run stayed open and the
    // call stayed active, so a late result from the worker found them, moved
    // the task back to `running` and carried it on to `verify`.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('cancel', 'cycle-minimal', 'cycle', 'planning');
    session.tasks.implementation = [createTask()];
    await store.save(session);

    const hooks = createRuntime(pluginInput()) as Hooks & { tool?: ToolMap };
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 'cancel', callID: 'call-1' },
      { args: { subagent_type: 'code', description: '[workflow-task:task-1] work' } }
    );
    expect(Object.values((await store.load('cancel'))!.loopRuns)).toHaveLength(1);

    await hooks.tool!['workflow-tasks-set-status']!.execute(
      { taskId: 'task-1', status: 'cancelled' },
      { sessionID: 'cancel', agent: 'orchestrator' }
    );

    const after = await store.load('cancel');
    expect(after?.tasks.implementation?.[0]?.status).toBe('cancelled');
    expect(Object.values(after!.loopRuns).every((run) => run.status === 'cancelled')).toBe(true);
    expect(after?.activeOperations).toEqual({});

    // The worker's late result now has nothing to attach to.
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 'cancel', callID: 'call-1', args: { subagent_type: 'code' } },
      {
        title: 'task',
        output:
          '<workflow-result>{"stage":"dev","status":"pass","summary":"ok","evidence":["ok"]}</workflow-result>',
        metadata: {},
      }
    );

    const final = await store.load('cancel');
    expect(final?.tasks.implementation?.[0]?.status).toBe('cancelled');
  });
});

describe('inheritance keeps what the grandparent forbids', () => {
  it('carries the grandparent down a three-link chain', async () => {
    // Only the immediate parent was consulted, and it was loaded raw rather
    // than resolved — so in C → B → A, B kept A's stages and C lost them.
    const { resolveConfig } = await import('../../src/public-api.ts');
    const root = fixtureProfilesDir('profiles');

    const c = await resolveConfig('chain-c', root);

    expect(Object.keys(c.schemas[0]?.stages ?? {}).sort()).toEqual(['done', 'planning']);
  });
});

describe('a schema a profile declares and does not have', () => {
  it('is a configuration error, not an empty workflow', async () => {
    // The resolver returned a stub, so workflow-create reported success and
    // persisted a session with `currentStage: ''` — a session under a state
    // machine with no states.
    const store = new WorkflowStore(storeDirectory);
    const hooks = createRuntime(pluginInput()) as Hooks & { tool?: ToolMap };

    const result = await hooks.tool!['workflow-create']!.execute(
      { schemaId: 'absent-schema/absent' },
      { sessionID: 'absent' }
    );

    expect(result.output).not.toContain('Created session');
    expect(result.output).toContain('absent.yaml');
    expect(await store.load('absent')).toBeNull();
  });
});

describe('a nested loop can actually run', () => {
  it('admits a child task from the list its own loop owns', async () => {
    // `execution` cycles over `parents`; `subtasks` inside it cycles over
    // `$currentTask.id`. Admission looked only in the outer list, so the child
    // was always "not eligible in loopStage execution".
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('nested', 'nested-loop', 'flow', 'planning');
    session.currentStage = 'execution';
    session.tasks.parents = [createTask({ id: 'task-1' })];
    session.tasks['task-1'] = [createTask({ id: 'task-2' })];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 'nested', callID: 'call-child' },
        { args: { subagent_type: 'code', description: '[workflow-task:task-2] child work' } }
      )
    ).resolves.toBeUndefined();

    const after = await store.load('nested');
    const run = Object.values(after!.loopRuns).find((entry) => entry.taskId === 'task-2');
    expect(run?.listKey).toBe('task-1');
  });
});

describe('a parent does not block its own child', () => {
  it('admits the child of a running parent task', async () => {
    // The parent occupies `parents`; the child's cycle owns `task-1`. Serial
    // admission counted every open run in the session, so the parent's own run
    // refused the child — and the parent waits for a child that may not start.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('nested-parent', 'nested-loop', 'flow', 'planning');
    session.currentStage = 'execution';
    session.tasks.parents = [createTask({ id: 'task-1' })];
    session.tasks['task-1'] = [createTask({ id: 'task-2' })];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());

    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 'nested-parent', callID: 'call-parent' },
      { args: { subagent_type: 'code', description: '[workflow-task:task-1] parent work' } }
    );

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 'nested-parent', callID: 'call-child' },
        { args: { subagent_type: 'code', description: '[workflow-task:task-2] child work' } }
      )
    ).resolves.toBeUndefined();

    const after = await store.load('nested-parent');
    const child = Object.values(after!.loopRuns).find((entry) => entry.taskId === 'task-2');
    expect(child?.listKey).toBe('task-1');
  });
});

describe('a task says who may edit it, and the stage is asked whether it edits', () => {
  it('refuses an agent the task does not list, on a stage with no `gates:` field', async () => {
    // `stage.gates?.length === 0` is false when a stage declares no `gates:`
    // at all — which is most stages — so the check was skipped for exactly the
    // case it was written for. The shipped base profile is one: its stages
    // deliberately declare no roster, so every agent may run there, editors
    // included, and the stage is one where work happens.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('editors', 'editors', 'flow', 'planning');
    session.currentStage = 'execution';
    session.tasks.implementation = [createTask({ editingAgents: ['different-editor'] })];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 'editors', callID: 'call-1' },
        { args: { subagent_type: 'code', description: '[workflow-task:task-1] work' } }
      )
    ).rejects.toThrow(/may not edit task-1/);
  });

  it('admits the agent the task does list', async () => {
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('editors-ok', 'editors', 'flow', 'planning');
    session.currentStage = 'execution';
    session.tasks.implementation = [createTask({ editingAgents: ['code'] })];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 'editors-ok', callID: 'call-1' },
        { args: { subagent_type: 'code', description: '[workflow-task:task-1] work' } }
      )
    ).resolves.toBeUndefined();
  });
});

describe('a nested task finishes, not only starts', () => {
  it('resolves its own loop when the result comes back', async () => {
    // Admission was taught to find a nested loop; the result handler asks the
    // same question through getLoopStage, which searched only the top level.
    // The task reported success and stayed `running` behind
    // `workflow-task-unreachable: no loop stage resolved`.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('finish', 'nested-loop', 'flow', 'planning');
    session.currentStage = 'execution';
    session.tasks.parents = [createTask({ id: 'task-1' })];
    session.tasks['task-1'] = [createTask({ id: 'task-2' })];
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 'finish', callID: 'call-child' },
      { args: { subagent_type: 'code', description: '[workflow-task:task-2] child work' } }
    );

    const output = {
      title: 'task',
      output:
        '<workflow-result>{"stage":"child","status":"pass","summary":"ok","evidence":["ok"]}</workflow-result>',
      metadata: {},
    };
    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: 'finish', callID: 'call-child', args: { subagent_type: 'code' } },
      output
    );

    expect(output.output).not.toContain('no loop stage resolved');
    // Ребро `execution → done` не охраняется, так что тем же ходом сессия
    // приходит в конец workflow и уезжает из рантайма в архив: «сессии нет»
    // выражается отсутствием файла там, где его ищут, и второго способа
    // не-существования в проекте нет. Итог при этом цел и читается.
    expect(await store.load('finish')).toBeNull();
    const after = await store.loadArchived('finish');
    expect(after?.currentStage).toBe('done');
    expect(after?.tasks['task-1']?.[0]?.status).toBe('completed');

    // Чем и почему кончилось. Без этой записи `done` и `failed` выглядят в
    // архиве одинаково — стадия и больше ничего, — и читатель видит исход, но
    // не причину. Ребро `execution → done` в этой фикстуре без условия, так
    // что причина честно пуста, а не выдумана.
    expect(after?.outcome?.stage).toBe('done');
    expect(after?.outcome?.from).toBe('execution');
    expect(after?.outcome?.guard).toBeNull();
    expect(after?.outcome?.failedGates).toEqual([]);
    expect(after?.outcome?.recordedAt).toBeTruthy();
  });
});

describe('reading a task list from a dispatched subagent', () => {
  it('resolves the root session instead of refusing', async () => {
    // Taking the write out of the read took the queue's root resolution with
    // it: a read from a child session answered `Unknown workflow session:
    // child` though the host knew its parent.
    const { TaskApi } = await import('../../src/app/task-api.ts');
    const { SessionExecutor } = await import('../../src/app/session-executor.ts');

    const store = new WorkflowStore(storeDirectory);
    const session = createSession('root', 'base', 'state-machine', 'planning');
    session.tasks.implementation = [createTask()];
    await store.save(session);

    const chain: Record<string, string> = { child: 'root' };
    const executor = new SessionExecutor(store, undefined, async (id) => chain[id] ?? null);
    const api = new TaskApi(store, async () => ['implementation'], executor);

    const fromChild = await api.getTasks('child', 'implementation');
    expect(fromChild).toHaveLength(1);

    // And it still writes nothing.
    expect((await store.load('root'))?.revision).toBe(1);
  });
});

/**
 * Чем и почему кончился workflow.
 *
 * До этой записи `done` и `failed` выглядели в файле одинаково — стадия и
 * больше ничего, — так что «завершилось», «провалилось» и «застряло»
 * читались неразличимо. Причину называет схема: `guard` ребра, по которому
 * ушли в конец, слово в слово как его написал автор профиля.
 */
describe('исход workflow записывается при входе в терминальную стадию', () => {
  async function drive(sessionId: string, reviewStatus: 'passed' | 'failed') {
    const store = new WorkflowStore(storeDirectory);
    const session = createSession(sessionId, 'outcome', 'flow', 'work');
    session.currentStage = 'work';
    session.gates = [{ id: 'review', status: reviewStatus }];
    if (reviewStatus === 'failed') {
      session.retryBudgets = { cycles: { attempts: 3, maximum: 3 } };
    }
    await store.save(session);

    const hooks: Hooks = createRuntime(pluginInput());
    // Переходы применяются после любого инструмента; читающий `bash` подходит.
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: sessionId, callID: 'call-1', args: { command: 'git status' } },
      { title: 'bash', output: '', metadata: {} }
    );
    return store;
  }

  it('записывает условие ребра как причину и уезжает в архив', async () => {
    const store = await drive('outcome-done', 'passed');

    expect(await store.load('outcome-done')).toBeNull();
    const after = await store.loadArchived('outcome-done');
    expect(after?.currentStage).toBe('done');
    expect(after?.outcome?.from).toBe('work');
    expect(after?.outcome?.stage).toBe('done');
    expect(after?.outcome?.guard).toBe("session.gates.review == 'passed'");
    expect(after?.outcome?.failedGates).toEqual([]);
  });

  it('на провале называет и условие, и упавший гейт, и исчерпанный бюджет', async () => {
    const store = await drive('outcome-failed', 'failed');

    const after = await store.loadArchived('outcome-failed');
    expect(after?.currentStage).toBe('failed');
    expect(after?.outcome?.stage).toBe('failed');
    expect(after?.outcome?.guard).toBe("session.gates.review == 'failed'");
    expect(after?.outcome?.failedGates).toEqual(['review']);
    expect(after?.outcome?.exhaustedBudgets).toEqual(['cycles']);
  });
});
