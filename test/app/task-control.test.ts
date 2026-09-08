import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hooks, PluginInput, ToolContext } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';
import { toolOutput } from '../support/tool-result.ts';

let storeDirectory: string;
let profilesDirectory: string;
let previousStoreDirectory: string | undefined;
let previousProfilesDirectory: string | undefined;
let taskControlProfileId = 'cycle-minimal';

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

function setFixtureProfilesDir(profileId = 'cycle-minimal'): void {
  process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
  taskControlProfileId = profileId;
}

async function createWorkflowSession(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', taskControlProfileId, 'cycle');
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
  return hooks.tool!['workflow-tasks-set-status'].execute(
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
  taskControlProfileId = 'cycle-minimal';
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
    setFixtureProfilesDir();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'orchestrator');

    expect(toolOutput(result)).toBe('Updated task-1 to completed');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('completed');
  });

  it('accepts the profile-qualified orchestrator name the host reports', async () => {
    setFixtureProfilesDir();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'cycle-minimal/orchestrator');

    expect(toolOutput(result)).toBe('Updated task-1 to completed');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('completed');
  });

  it('refuses a worker agent closing its own task', async () => {
    setFixtureProfilesDir();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'code');

    expect(toolOutput(result)).toContain('refused');
    expect(toolOutput(result)).toContain('orchestrator');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('pending');
  });

  it("refuses another profile's orchestrator", async () => {
    setFixtureProfilesDir();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, 'android/orchestrator');

    expect(toolOutput(result)).toContain('refused');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('pending');
  });

  it('refuses a caller whose agent the host did not report', async () => {
    setFixtureProfilesDir();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await setStatus(hooks, undefined);

    expect(toolOutput(result)).toContain('refused');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('pending');
  });

  it('honours taskControlAgents declared by the schema', async () => {
    setFixtureProfilesDir('task-control-lead');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const refused = await setStatus(hooks, 'orchestrator');
    const allowed = await setStatus(hooks, 'lead');

    expect(toolOutput(refused)).toContain('refused');
    expect(toolOutput(allowed)).toBe('Updated task-1 to completed');
    expect((await load(store)).tasks.implementation[0]!.status).toBe('completed');
  });

  it('refuses a worker replacing the whole task list', async () => {
    setFixtureProfilesDir();
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await hooks.tool!['workflow-tasks-set'].execute(
      { tasks: [{ status: 'completed' }] },
      toolContext('code')
    );

    expect(toolOutput(result)).toContain('refused');
    expect((await load(store)).tasks.implementation).toHaveLength(2);
  });

  it('refuses a worker resolving a retry decision', async () => {
    setFixtureProfilesDir();
    await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await hooks.tool!['workflow-tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2 },
      toolContext('code')
    );

    expect(toolOutput(result)).toContain('refused');
  });

  it('leaves reads open to every agent', async () => {
    setFixtureProfilesDir();
    await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    const result = await hooks.tool!['workflow-tasks-get'].execute(
      { listKey: 'implementation' },
      toolContext('code')
    );

    expect(toolOutput(result)).toBe('implementation: 2 task(s)');
  });
});
