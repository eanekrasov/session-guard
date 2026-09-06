import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput, ToolContext } from '@opencode-ai/plugin';

import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';
import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

type DispatchStrategy = 'serial' | 'parallel' | 'serial_with_overlap';
type TaskFixture = {
  id: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
};

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

// Workflow task state is orchestrator-owned, so the retry decisions below are
// made as the orchestrator — a worker agent is refused (see task-control.test.ts).
function toolContext(agent = 'orchestrator'): ToolContext {
  return {
    sessionID: 's1',
    messageID: 'message-1',
    agent,
    directory: '/tmp/test',
    worktree: '/tmp/test',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

let taskRetryProfileId = 'cycle-serial';

/**
 * Point the runtime at the fixture profile this scenario needs.
 *
 * The signature is the one the tests already call; what changed is that the
 * profile is a file under `test/fixtures/profiles` rather than YAML assembled
 * here. A test that needs a new combination gets a fixture, not another flag.
 */
function writeProfile(
  strategy: DispatchStrategy,
  options: { maxConcurrent?: number; retryMaximum?: number; loop?: string } = {}
): void {
  setFixtureProfilesDir();
  if (options.loop === '$currentTask.id') taskRetryProfileId = 'cycle-retry-current-task';
  else if (strategy === 'parallel') taskRetryProfileId = 'cycle-retry-parallel-1';
  else if (options.retryMaximum !== undefined) taskRetryProfileId = 'cycle-retry-serial';
  else taskRetryProfileId = 'cycle-serial';
}

async function createWorkflowSession(
  tasks: TaskFixture[] = [{ id: 'task-1' }, { id: 'task-2' }],
  childTasks: Record<string, TaskFixture[]> = {}
): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', taskRetryProfileId, 'cycle');
  session.tasks.implementation = tasks.map((task) => ({
    id: task.id,
    status: task.status ?? 'pending',
  }));
  for (const [listKey, children] of Object.entries(childTasks)) {
    session.tasks[listKey] = children.map((task) => ({
      id: task.id,
      status: task.status ?? 'pending',
    }));
  }
  await store.save(session);
  return store;
}

async function beforeTask(
  hooks: Hooks,
  callID: string,
  taskId = 'task-1',
  agent = 'code'
): Promise<{ args: unknown; blockedReason?: string }> {
  const nativeArgs: Record<string, unknown> = {
    subagent_type: agent,
    task_id: 'native-subagent-session',
    description: `[workflow-task:${taskId}] Do the workflow task`,
  };
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
  return { args: output.args, blockedReason };
}

async function afterTask(
  hooks: Hooks,
  callID: string,
  stage: 'review' | 'qa',
  status: 'pass' | 'fail'
): Promise<void> {
  await hooks['tool.execute.after']!(
    { tool: 'task', sessionID: 's1', callID, args: {} },
    {
      title: 'workflow task',
      output: `<workflow-result>${JSON.stringify({
        stage,
        status,
        summary: `${stage} ${status}`,
        evidence: [`${stage}-evidence`],
      })}</workflow-result>`,
      metadata: {},
    }
  );
}

async function load(store: WorkflowStore): Promise<WorkflowSession> {
  const session = await store.load('s1');
  if (!session) throw new Error('test session was not persisted');
  return session;
}

beforeEach(async () => {
  previousStoreDirectory = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDirectory = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'task-retry-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'task-retry-profiles-'));
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

describe('task-cycle retry and recovery', () => {
  it('retries a failed stage by returning the same task to dev and incrementing its budget', async () => {
    writeProfile('serial');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');
    const retry = await beforeTask(hooks, 'call-2');
    const loaded = await load(store);

    expect(loaded.retryBudgets['task-1']).toEqual({ attempts: 1, maximum: 3 });
    expect(loaded.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'running' });
    expect(loaded.tasks.implementation[0].status).toBe('running');
    expect(retry.args).toEqual(expect.objectContaining({ description: expect.any(String) }));
    expect(loaded.activeOperations['call-2']).toMatchObject({
      taskId: 'task-1',
      status: 'running',
    });
  });

  it('creates a pending decision on retry exhaustion without failing the task', async () => {
    writeProfile('parallel', { maxConcurrent: 1, retryMaximum: 1 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');
    const rejected = await beforeTask(hooks, 'call-retry');
    const system: { system: string[] } = { system: [] };
    await hooks['experimental.chat.system.transform']!({ sessionID: 's1' }, system);
    const loaded = await load(store);

    expect(loaded.retryBudgets['task-1']).toEqual({ attempts: 1, maximum: 1 });
    expect(loaded.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'awaiting_decision' });
    expect(loaded.tasks.implementation[0].status).toBe('running');
    expect(loaded.pendingDecisions).toEqual([
      expect.objectContaining({
        subject: 'task',
        subjectId: 'task-1',
        kind: 'retry_exhausted',
        status: 'pending',
      }),
    ]);
    expect(rejected.blockedReason).toEqual(expect.any(String));
    expect(system.system).toContain(
      '[workflow pending decision: task task-1 retry_exhausted; use workflow.tasks-resolve-decision (no taskId needed)]'
    );
  });

  it('resolves an exhausted retry decision by increasing the absolute maximum', async () => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');
    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2 },
      toolContext()
    );
    const retry = await beforeTask(hooks, 'call-2');
    const loaded = await load(store);

    expect(result.output).toBe('Increased retry maximum for task-1 to 2');
    expect(loaded.retryBudgets['task-1']).toEqual({ attempts: 1, maximum: 2 });
    expect(loaded.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'running' });
    expect(loaded.pendingDecisions).toEqual([]);
    expect(retry.args).toEqual(expect.objectContaining({ description: expect.any(String) }));
  });

  it.each([
    ['failed', 'Failed task-1 after retry decision'],
    ['cancelled', 'Cancelled task-1 after retry decision'],
  ] as const)('resolves an exhausted retry decision as %s', async (decision, output) => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');
    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision },
      toolContext()
    );
    const loaded = await load(store);

    expect(result.output).toBe(output);
    expect(loaded.loopRuns['run-1'].status).toBe(decision);
    expect(loaded.tasks.implementation[0].status).toBe(decision);
    expect(loaded.pendingDecisions).toEqual([]);
  });

  it('records native interruption without failing the task or consuming retry budget', async () => {
    writeProfile('serial');
    const store = await createWorkflowSession();
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1');
    await hooks.event!({
      event: { type: 'message.part.updated', part: { id: 'call-1', status: 'failed' } },
    });
    const loaded = await load(store);

    expect(loaded.activeOperations['call-1']).toMatchObject({
      taskId: 'task-1',
      status: 'interrupted',
    });
    expect(loaded.retryBudgets).toEqual({});
    expect(loaded.loopRuns['run-1']).toMatchObject({ stage: 'dev', status: 'running' });
    expect(loaded.tasks.implementation[0].status).toBe('running');
  });

  it('leaves a parent task running when its child task is terminally failed', async () => {
    writeProfile('serial', { retryMaximum: 1, loop: '$currentTask.id' });
    const store = await createWorkflowSession([{ id: 'task-1', status: 'running' }], {
      'task-1': [{ id: 'task-2' }],
    });
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-child', 'task-2');
    await afterTask(hooks, 'call-child', 'review', 'fail');
    await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'failed' },
      toolContext()
    );
    const loaded = await load(store);

    expect(loaded.tasks.implementation[0].status).toBe('running');
    expect(loaded.tasks['task-1'][0].status).toBe('failed');
    expect(loaded.loopRuns['run-1']).toMatchObject({
      taskId: 'task-2',
      ancestry: [{ listKey: 'implementation', taskId: 'task-1' }],
      status: 'failed',
    });
  });

  // ── Parallel retry decisions ──

  it('REGRESSION: two pending contexts without decisionId selector are rejected with candidates', async () => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession([{ id: 'task-1' }, { id: 'task-2' }]);
    const hooks = createRuntime(pluginInput());

    // Exhaust task-1
    await beforeTask(hooks, 'call-1', 'task-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');

    // Exhaust task-2 — manually create second decision to avoid dispatch ordering
    const loaded = await load(store);
    loaded.pendingDecisions.push({
      id: 'task-2:retry_exhausted',
      subject: 'task',
      subjectId: 'task-2',
      runId: 'run-2',
      kind: 'retry_exhausted',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    loaded.activeTaskContexts.push({
      runId: 'run-2',
      taskId: 'task-2',
      agent: 'code',
      status: 'awaiting_decision' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    loaded.loopRuns['run-2'] = {
      id: 'run-2',
      taskId: 'task-2',
      listKey: 'implementation',
      ancestry: [],
      stage: 'dev',
      status: 'awaiting_decision',
      priority: 0,
    };
    loaded.retryBudgets['task-2'] = { attempts: 1, maximum: 1 };
    await store.save(loaded);

    // Try to resolve without decisionId — must fail with candidates
    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2 },
      toolContext()
    );
    expect(result.output).toContain('Candidate decision IDs');

    // Session state unchanged (both decisions still pending)
    const loaded2 = await load(store);
    expect(loaded2.pendingDecisions.filter((d) => d.status === 'pending')).toHaveLength(2);
  });

  it('REGRESSION: explicit decisionId resolves only the selected decision', async () => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession([{ id: 'task-1' }, { id: 'task-2' }]);
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', 'task-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');

    // Manually add second decision
    const loaded = await load(store);
    loaded.pendingDecisions.push({
      id: 'task-2:retry_exhausted',
      subject: 'task',
      subjectId: 'task-2',
      runId: 'run-2',
      kind: 'retry_exhausted',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    loaded.activeTaskContexts.push({
      runId: 'run-2',
      taskId: 'task-2',
      agent: 'code',
      status: 'awaiting_decision' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    loaded.loopRuns['run-2'] = {
      id: 'run-2',
      taskId: 'task-2',
      listKey: 'implementation',
      ancestry: [],
      stage: 'dev',
      status: 'awaiting_decision',
      priority: 0,
    };
    loaded.retryBudgets['task-2'] = { attempts: 1, maximum: 1 };
    await store.save(loaded);

    // Resolve task-1 only
    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'failed', decisionId: 'task-1:retry_exhausted' },
      toolContext()
    );
    expect(result.output).toMatch(/Failed.*task-1/);

    const loaded2 = await load(store);
    expect(loaded2.pendingDecisions.filter((d) => d.status === 'pending')).toHaveLength(1);
    expect(loaded2.pendingDecisions[0].subjectId).toBe('task-2');

    // task-2 is still resolvable independently
    const result2 = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2, decisionId: 'task-2:retry_exhausted' },
      toolContext()
    );
    expect(result2.output).toMatch(/Increased.*task-2/);

    const loaded3 = await load(store);
    expect(loaded3.pendingDecisions.filter((d) => d.status === 'pending')).toHaveLength(0);
  });

  it('REGRESSION: unknown decisionId is rejected without mutation', async () => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession([{ id: 'task-1' }]);
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', 'task-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');

    // Unknown decisionId
    const result1 = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'failed', decisionId: 'nonexistent-id' },
      toolContext()
    );
    expect(result1.output).toContain('No pending retry decision found');

    // State unchanged
    const loaded1 = await load(store);
    expect(loaded1.pendingDecisions.filter((d) => d.status === 'pending')).toHaveLength(1);
  });

  it('REGRESSION: missing retry budget prevents mutation', async () => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession([{ id: 'task-1' }]);
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', 'task-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');

    // Remove budget
    const loaded = await load(store);
    delete loaded.retryBudgets['task-1'];
    await store.save(loaded);

    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2 },
      toolContext()
    );
    expect(result.output).toContain('No retry budget');
  });

  it('REGRESSION: save and reload with two pending decisions — both survive', async () => {
    writeProfile('serial', { retryMaximum: 1 });
    const store = await createWorkflowSession([{ id: 'task-1' }, { id: 'task-2' }]);
    const hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', 'task-1');
    await afterTask(hooks, 'call-1', 'review', 'fail');

    // Manually add second decision
    const loaded = await load(store);
    loaded.pendingDecisions.push({
      id: 'task-2:retry_exhausted',
      subject: 'task',
      subjectId: 'task-2',
      runId: 'run-2',
      kind: 'retry_exhausted',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    loaded.activeTaskContexts.push({
      runId: 'run-2',
      taskId: 'task-2',
      agent: 'code',
      status: 'awaiting_decision' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    loaded.loopRuns['run-2'] = {
      id: 'run-2',
      taskId: 'task-2',
      listKey: 'implementation',
      ancestry: [],
      stage: 'dev',
      status: 'awaiting_decision',
      priority: 0,
    };
    loaded.retryBudgets['task-2'] = { attempts: 1, maximum: 1 };
    await store.save(loaded);

    // Reload from store
    const loaded1 = await load(store);
    expect(loaded1.pendingDecisions.filter((d) => d.status === 'pending')).toHaveLength(2);
    expect(loaded1.pendingDecisions[0].runId).toBeDefined();
    expect(loaded1.pendingDecisions[1].runId).toBeDefined();

    // Resolve task-1 via decisionId
    const result = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'failed', decisionId: 'task-1:retry_exhausted' },
      toolContext()
    );
    expect(result.output).toMatch(/Failed.*task-1/);

    // Resolve task-2 via decisionId
    const result2 = await hooks.tool!['workflow.tasks-resolve-decision'].execute(
      { decision: 'increase', maximum: 2, decisionId: 'task-2:retry_exhausted' },
      toolContext()
    );
    expect(result2.output).toMatch(/Increased.*task-2/);

    const loaded2 = await load(store);
    expect(loaded2.pendingDecisions.filter((d) => d.status === 'pending')).toHaveLength(0);
  });
});
