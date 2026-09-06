import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput, ToolContext } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

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

function toolContext(agent: string | undefined): ToolContext {
  return {
    sessionID: 's1',
    messageID: 'message-1',
    agent: agent as string,
    directory: '/tmp/test',
    worktree: '/tmp/test',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

async function writeProfile(taskControlAgents?: string[]): Promise<void> {
  const profileDirectory = join(profilesDirectory, 'task-control');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'task-control', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    stages:',
      '      dev:',
      "        allowedAgents: ['code']",
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
      ...(taskControlAgents === undefined
        ? []
        : [`taskControlAgents: [${taskControlAgents.map((a) => `'${a}'`).join(', ')}]`]),
    ].join('\n'),
    'utf-8'
  );
}

async function createWorkflowSession(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'task-control');
  session.tasks.implementation = [createTask(), createTask({ id: 'task-2', status: 'pending' })];
  await store.save(session);
  return store;
}

async function load(store: WorkflowStore): Promise<WorkflowSession> {
  const session = await store.load('s1');
  if (!session) throw new Error('test session was not persisted');
  return session;
}

function setStatus(hooks: Hooks, agent: string | undefined) {
  return hooks.tool!['workflow.tasks-set-status'].execute(
    { taskId: 'task-1', status: 'completed' },
    toolContext(agent)
  );
}

beforeEach(async () => {
  previousStoreDirectory = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDirectory = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'task-control-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'task-control-profiles-'));
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

describe('workflow task state is orchestrator-owned', () => {
  it('lets the orchestrator set a task status', async () => {
    await writeProfile();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'orchestrator');

    expect(result.output).toBe('Updated task-1 to completed');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('completed');
  });

  it('accepts the profile-qualified orchestrator name the host reports', async () => {
    await writeProfile();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'task-control/orchestrator');

    expect(result.output).toBe('Updated task-1 to completed');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('completed');
  });

  it('refuses a worker agent closing its own task', async () => {
    await writeProfile();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'code');

    expect(result.output).toContain('refused');
    expect(result.output).toContain('orchestrator');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('pending');
  });

  it("refuses another profile's orchestrator", async () => {
    await writeProfile();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'android/orchestrator');

    expect(result.output).toContain('refused');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('pending');
  });

  it('refuses a caller whose agent the host did not report', async () => {
    await writeProfile();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, undefined);

    expect(result.output).toContain('refused');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('pending');
  });

  it('honours taskControlAgents declared by the schema', async () => {
    await writeProfile(['lead']);
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const refused = await setStatus(hooks, 'orchestrator');
    const allowed = await setStatus(hooks, 'lead');

    expect(refused.output).toContain('refused');
    expect(allowed.output).toBe('Updated task-1 to completed');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('completed');
  });

  it('refuses a worker replacing the whole task list', async () => {
    await writeProfile();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await hooks.tool!['workflow.tasks-set'].execute(
      { tasks: [{ status: 'completed' }] },
      toolContext('code')
    );

    expect(result.output).toContain('refused');
    expect((await load(store)).tasks.implementation).toHaveLength(2);
  });

  it('refuses a worker resolving a retry decision', async () => {
    await writeProfile();
    await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2 },
      toolContext('code')
    );

    expect(result.output).toContain('refused');
  });

  it('leaves reads open to every agent', async () => {
    await writeProfile();
    await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await hooks.tool!['workflow.tasks-get'].execute(
      { listKey: 'implementation' },
      toolContext('code')
    );

    expect(result.output).toBe('implementation: 2 task(s)');
  });
});
