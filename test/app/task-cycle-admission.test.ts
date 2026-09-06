import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

type DispatchStrategy = 'serial' | 'parallel' | 'serial_with_overlap';

let storeDirectory: string;
let profilesDirectory: string;
let previousStoreDirectory: string | undefined;
let previousProfilesDirectory: string | undefined;

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

let taskAdmissionProfileId = 'cycle-serial';

function setTaskAdmissionFixtureProfilesDir(
  strategy: DispatchStrategy,
  options: { maxConcurrent?: number; allowedAgents?: string[] } = {}
): void {
  process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
  if (strategy === 'serial_with_overlap') taskAdmissionProfileId = 'cycle-overlap-2';
  else if (strategy === 'parallel' && options.maxConcurrent === 1)
    taskAdmissionProfileId = 'cycle-parallel-1';
  else if (strategy === 'parallel') taskAdmissionProfileId = 'cycle-parallel-2';
  else if (options.allowedAgents?.includes('review'))
    taskAdmissionProfileId = 'cycle-serial-review';
  else taskAdmissionProfileId = 'cycle-serial';
}

async function createWorkflowSession(
  tasks: Array<{ id: string; status?: 'pending' | 'running' | 'completed' }> = [
    { id: 'task-1' },
    { id: 'task-2' },
  ]
): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', taskAdmissionProfileId);
  session.tasks.implementation = tasks.map((task) => ({
    id: task.id,
    path: `src/${task.id}.ts`,
    status: task.status ?? 'pending',
  }));
  await store.save(session);
  return store;
}

async function beforeTask(
  hooks: Hooks,
  callID: string,
  description: string | undefined,
  agent = 'code'
): Promise<{ args: unknown; nativeArgs: Record<string, unknown>; blockedReason?: string }> {
  const nativeArgs: Record<string, unknown> = {
    subagent_type: agent,
    task_id: 'native-subagent-session',
    prompt: 'Do the workflow task',
  };
  if (description !== undefined) nativeArgs.description = description;
  const output: { args: unknown } = { args: nativeArgs };
  const input: { tool: string; sessionID: string; callID: string } = {
    tool: 'task',
    sessionID: 's1',
    callID,
  };
  // A refusal is a rejected hook — that is the only signal the host acts on.
  let blockedReason: string | undefined;
  try {
    await hooks['tool.execute.before']!(input, output);
  } catch (err) {
    blockedReason = err instanceof Error ? err.message : String(err);
  }
  return { args: output.args, nativeArgs, blockedReason };
}

async function afterTask(hooks: Hooks, callID: string, outputText: string): Promise<void> {
  await hooks['tool.execute.after']!(
    { tool: 'task', sessionID: 's1', callID, args: {} },
    { title: 'workflow task', output: outputText, metadata: {} }
  );
}

function workflowResult(stage: 'review' | 'qa', status: 'pass' | 'fail'): string {
  return `<workflow-result>${JSON.stringify({
    stage,
    status,
    summary: `${stage} ${status}`,
    evidence: [`${stage}-evidence`],
  })}</workflow-result>`;
}

async function load(store: WorkflowStore): Promise<WorkflowSession> {
  const session = await store.load('s1');
  if (!session) throw new Error('test session was not persisted');
  return session;
}

beforeEach(async () => {
  previousStoreDirectory = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDirectory = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'task-admission-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'task-admission-profiles-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;
});

afterEach(async () => {
  if (previousStoreDirectory === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStoreDirectory;
  if (previousProfilesDirectory === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfilesDirectory;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
});

describe('task-cycle admission', () => {
  it('correlates an exact workflow prefix without changing native task arguments', async () => {
    setTaskAdmissionFixtureProfilesDir('serial');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const invocation = await beforeTask(hooks, 'call-1', '[workflow-task:task-1] Implement parser');
    const session = await load(store);

    expect(invocation.args).toBe(invocation.nativeArgs);
    expect(invocation.nativeArgs.description).toBe('[workflow-task:task-1] Implement parser');
    expect(invocation.nativeArgs.task_id).toBe('native-subagent-session');
    expect(session.activeOperations['call-1']).toMatchObject({
      callId: 'call-1',
      taskId: 'task-1',
      agent: 'code',
      status: 'running',
    });
    const runId = session.activeOperations['call-1'].runId;
    expect(session.loopRuns[runId]).toEqual({
      id: runId,
      taskId: 'task-1',
      listKey: 'implementation',
      ancestry: [],
      stage: 'dev',
      status: 'running',
      gates: {},
      round: 0,
    });
    expect(session.tasks.implementation[0].status).toBe('running');
  });

  it.each([
    undefined,
    'Implement parser',
    '[workflow-task:task-x] Implement parser',
    ' [workflow-task:task-1] Implement parser',
    '[workflow-task:task-1-extra] Implement parser',
  ])(
    'passes without admission for missing or malformed workflow prefix: %s',
    async (description) => {
      setTaskAdmissionFixtureProfilesDir('serial');
      const store = await createWorkflowSession();
      const hooks = createRuntime(pluginInput());

      const invocation = await beforeTask(hooks, 'bad-call', description);

      // isWorkflowTask отсекает такие вызовы — они проходят без admission
      expect(invocation.blockedReason).toBeUndefined();

      const session = await load(store);
      expect(session.activeOperations).toEqual({});
      expect(session.loopRuns).toEqual({});
    }
  );

  it('rejects a task outside the selected loop', async () => {
    setTaskAdmissionFixtureProfilesDir('parallel', { maxConcurrent: 2 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const invocation = await beforeTask(
      hooks,
      'unknown-task',
      '[workflow-task:task-99] Unknown task'
    );

    expect(invocation.blockedReason).toEqual(expect.any(String));
    expect((await load(store)).activeOperations).toEqual({});
  });

  it('rejects an agent outside the current stage allowedAgents', async () => {
    setTaskAdmissionFixtureProfilesDir('serial', { allowedAgents: ['code'] });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const invocation = await beforeTask(
      hooks,
      'wrong-agent',
      '[workflow-task:task-1] Implement parser',
      'review'
    );

    expect(invocation.blockedReason).toEqual(expect.any(String));
    expect((await load(store)).activeOperations).toEqual({});
  });

  it('admits independent parallel calls up to maxConcurrent and rejects excess work', async () => {
    setTaskAdmissionFixtureProfilesDir('parallel', { maxConcurrent: 2 });
    const store = await createWorkflowSession([
      { id: 'task-1' },
      { id: 'task-2' },
      { id: 'task-3' },
    ]);
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    await beforeTask(hooks, 'call-2', '[workflow-task:task-2] Second');
    const rejected = await beforeTask(hooks, 'call-3', '[workflow-task:task-3] Third');
    const session = await load(store);

    expect(rejected.blockedReason).toEqual(expect.any(String));
    expect(Object.keys(session.activeOperations)).toEqual(['call-1', 'call-2']);
    expect(
      new Set(Object.values(session.activeOperations).map((operation) => operation.runId)).size
    ).toBe(2);
    expect(Object.keys(session.loopRuns)).toHaveLength(2);
  });

  it('keeps a concurrency slot for the full loop run after its native call ends', async () => {
    setTaskAdmissionFixtureProfilesDir('parallel', { maxConcurrent: 1 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    await afterTask(hooks, 'call-1', workflowResult('review', 'pass'));

    const rejected = await beforeTask(hooks, 'call-2', '[workflow-task:task-2] Second');

    expect(rejected.blockedReason).toEqual(expect.any(String));
    expect(Object.keys((await load(store)).loopRuns)).toHaveLength(1);
  });

  it('advances successful native calls through dev, review, qa, and completes the run', async () => {
    setTaskAdmissionFixtureProfilesDir('serial');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-dev', '[workflow-task:task-1] Develop');
    await afterTask(hooks, 'call-dev', workflowResult('review', 'pass'));
    let session = await load(store);
    expect(session.activeOperations).toEqual({});
    expect(session.loopRuns['run-1'].stage).toBe('review');
    expect(session.loopRuns['run-1'].status).toBe('running');

    await beforeTask(hooks, 'call-review', '[workflow-task:task-1] Review', 'review');
    await afterTask(hooks, 'call-review', workflowResult('review', 'pass'));
    session = await load(store);
    expect(session.loopRuns['run-1'].stage).toBe('qa');

    await beforeTask(hooks, 'call-qa', '[workflow-task:task-1] QA', 'qa');
    await afterTask(hooks, 'call-qa', workflowResult('qa', 'pass'));
    session = await load(store);
    expect(session.activeOperations).toEqual({});
    expect(session.loopRuns['run-1'].status).toBe('completed');
    expect(session.tasks.implementation[0].status).toBe('completed');

    const next = await beforeTask(hooks, 'call-next', '[workflow-task:task-2] Next');
    expect(next.args).toEqual(expect.objectContaining({ description: expect.any(String) }));
  });

  it('releases the native call but does not advance on missing or malformed workflow results', async () => {
    setTaskAdmissionFixtureProfilesDir('serial');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-no-result', '[workflow-task:task-1] Develop');
    await afterTask(hooks, 'call-no-result', 'Implementation finished without a result');
    let session = await load(store);
    expect(session.activeOperations).toEqual({});
    expect(session.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'running' });
    expect(session.tasks.implementation[0].status).toBe('running');

    await beforeTask(hooks, 'call-malformed', '[workflow-task:task-1] Develop again');
    await afterTask(
      hooks,
      'call-malformed',
      '<workflow-result>{"stage":"review","status":"pass","summary":"ok","evidence":[]}</workflow-result>'
    );
    session = await load(store);
    expect(session.activeOperations).toEqual({});
    expect(session.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'running' });
    expect(session.tasks.implementation[0].status).toBe('running');
  });

  it('records a valid failed result as a retry and keeps the task cycle slot', async () => {
    setTaskAdmissionFixtureProfilesDir('parallel', { maxConcurrent: 1 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-fail', '[workflow-task:task-1] Develop');
    await afterTask(hooks, 'call-fail', workflowResult('review', 'fail'));
    let session = await load(store);
    expect(session.activeOperations).toEqual({});
    expect(session.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'running' });
    expect(session.tasks.implementation[0].status).toBe('running');

    const admitted = await beforeTask(hooks, 'call-next', '[workflow-task:task-2] Next');
    session = await load(store);
    expect(admitted.blockedReason).toEqual(expect.any(String));
    expect(session.activeOperations).toEqual({});
  });

  it('rejects reuse of a task that already has an active native call', async () => {
    setTaskAdmissionFixtureProfilesDir('parallel', { maxConcurrent: 2 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    const rejected = await beforeTask(hooks, 'call-2', '[workflow-task:task-1] Duplicate');

    expect(rejected.blockedReason).toEqual(expect.any(String));
    expect(Object.keys((await load(store)).activeOperations)).toEqual(['call-1']);
  });

  it('admits only the next unfinished task in serial mode', async () => {
    setTaskAdmissionFixtureProfilesDir('serial');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const outOfOrder = await beforeTask(hooks, 'call-2', '[workflow-task:task-2] Second');
    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    const session = await load(store);

    expect(outOfOrder.blockedReason).toEqual(expect.any(String));
    expect(Object.keys(session.activeOperations)).toEqual(['call-1']);
  });

  it('allows serial_with_overlap next dev only after the prior run leaves dev', async () => {
    setTaskAdmissionFixtureProfilesDir('serial_with_overlap', { maxConcurrent: 2 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    const tooEarly = await beforeTask(hooks, 'call-2-early', '[workflow-task:task-2] Second');
    await afterTask(hooks, 'call-1', workflowResult('review', 'pass'));

    const admitted = await beforeTask(hooks, 'call-2', '[workflow-task:task-2] Second');
    const loaded = await load(store);

    expect(tooEarly.blockedReason).toEqual(expect.any(String));
    expect(admitted.args).toEqual(expect.objectContaining({ description: expect.any(String) }));
    expect(loaded.activeOperations['call-2'].taskId).toBe('task-2');
    expect(Object.keys(loaded.loopRuns)).toHaveLength(2);
  });
});
