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

    await hooks.tool!['workflow.tasks-set-status']!.execute(
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
  it('carries an actionGuard down a three-link chain', async () => {
    // Only the immediate parent was consulted, and it was loaded raw rather
    // than resolved — so in C → B → A, B kept A's guards and C lost them.
    const { resolveConfig } = await import('../../src/public-api.ts');
    const root = fixtureProfilesDir('profiles');

    const b = await resolveConfig('chain-b', root);
    const c = await resolveConfig('chain-c', root);

    expect(b.schemas[0]?.actionGuards?.beginMutation).toBe('false');
    expect(c.schemas[0]?.actionGuards?.beginMutation).toBe('false');
    expect(Object.keys(c.schemas[0]?.stages ?? {}).sort()).toEqual(['done', 'planning']);
  });
});

describe('a schema a profile declares and does not have', () => {
  it('is a configuration error, not an empty workflow', async () => {
    // The resolver returned a stub, so workflow.create reported success and
    // persisted a session with `currentStage: ''` — a session under a state
    // machine with no states.
    const store = new WorkflowStore(storeDirectory);
    const hooks = createRuntime(pluginInput()) as Hooks & { tool?: ToolMap };

    const result = await hooks.tool!['workflow.create']!.execute(
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
