import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { LoopRun, WorkflowSession } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';
import { fixtureProfilesDir } from '../support/fixture-profiles.ts';

/**
 * Where a `<workflow-result>` lands.
 *
 * The tag names a gate. Which stage owns that gate — and therefore where the
 * verdict is recorded — must follow the gate's declaration, never the
 * bookkeeping of the call that produced it. These cases pin the invariant:
 * a verdict naming a declared gate, from an admitted agent, is recorded even
 * when the call has no `activeOperations` entry left, and a verdict that
 * cannot be honoured says so instead of vanishing.
 */

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

beforeEach(() => {
  previousStore = process.env.SESSION_GUARD_STORE_DIR;
  previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'verdict-routing-'));
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  process.env.SESSION_GUARD_PROFILES_DIR = fixtureProfilesDir('profiles');
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
  else process.env.SESSION_GUARD_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
  else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
  rmSync(storeDirectory, { recursive: true, force: true });
});

function loopRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    listKey: 'implementation',
    ancestry: [],
    stage: 'verify',
    status: 'running',
    gates: {},
    round: 0,
    ...overrides,
  };
}

async function seed(build: (session: WorkflowSession) => void, id = 's1'): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession(id, 'verify-default', 'cycle', 'execution');
  session.tasks.implementation = [createTask({ status: 'running' })];
  build(session);
  await store.save(session);
  return store;
}

/** Report a verdict through the after-hook and return what the agent was told. */
async function report(
  hooks: Hooks,
  sessionId: string,
  callID: string,
  gate: string,
  status: 'pass' | 'fail',
  agent: string | undefined
): Promise<string> {
  const tag = `<workflow-result>${JSON.stringify({
    gate,
    status,
    summary: `${gate} ${status}`,
    evidence: [`${gate}-evidence`],
  })}</workflow-result>`;
  const output = { title: 'task', output: tag, metadata: {} };
  await hooks['tool.execute.after']!(
    { tool: 'task', sessionID: sessionId, callID, args: agent ? { subagent_type: agent } : {} },
    output
  );
  return output.output;
}

async function load(store: WorkflowStore, id = 's1'): Promise<WorkflowSession | null> {
  return store.load(id);
}

function record(session: WorkflowSession, runId: string): LoopRun {
  return session.loopRuns[runId]!;
}

describe('a verdict is addressed by the gate it names', () => {
  test('records an outer-stage gate even when the call has no operation', async () => {
    // The gate's declaration is the address. The call bookkeeping is not.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('outer', 'verdict-outer', 'flow', 'work');
    await store.save(session);

    const hooks = createRuntime(pluginInput()) as Hooks;
    const told = await report(hooks, 'outer', 'call-outer', 'review', 'pass', 'reviewer');

    const after = await load(store, 'outer');
    expect(after?.stageGateResults.find((gate) => gate.id === 'review')?.status).toBe('passed');
    expect(told).not.toContain('[workflow-result-rejected]');
  });

  test('records a nested gate on the run its provenance names, with no operation', async () => {
    // The operation is deleted by the mutation lifecycle; the verdict's own
    // provenance is not. Addressing must survive that.
    const store = await seed((session) => {
      session.loopRuns['run-1'] = loopRun();
      session.verdictProvenance['call-nested'] = { runId: 'run-1', round: 0 };
    });

    const hooks = createRuntime(pluginInput()) as Hooks;
    const told = await report(hooks, 's1', 'call-nested', 'review', 'pass', 'reviewer');

    const after = await load(store);
    expect(record(after!, 'run-1').gates).toEqual({ review: 'passed' });
    expect(after?.verifications[0]?.gate).toBe('review');
    expect(told).not.toContain('[workflow-result-rejected]');
  });

  test('records a declared gate when the operation has no resolvable run or task', async () => {
    // The silent hole: an operation whose run and task do not resolve dropped
    // the verdict without a word. The gate is declared, so it is recorded.
    const store = new WorkflowStore(storeDirectory);
    const session = createSession('dangling', 'verdict-outer', 'flow', 'work');
    session.activeOperations['call-dangling'] = {
      callId: 'call-dangling',
      runId: 'run-missing',
      taskId: 'task-99',
      agent: 'reviewer',
      status: 'running',
      startedAt: new Date().toISOString(),
      round: 0,
      kind: 'task',
    };
    session.verdictProvenance['call-dangling'] = { runId: 'run-missing', round: 0 };
    await store.save(session);

    const hooks = createRuntime(pluginInput()) as Hooks;
    const told = await report(hooks, 'dangling', 'call-dangling', 'review', 'pass', 'reviewer');

    const after = await load(store, 'dangling');
    expect(after?.stageGateResults.find((gate) => gate.id === 'review')?.status).toBe('passed');
    expect(after?.activeOperations['call-dangling']).toBeUndefined();
    expect(told).not.toContain('[workflow-result-rejected]');
  });

  test('refuses a verdict from a round that is over, and records nothing', async () => {
    // The run has moved to a new round. The verdict was produced for the old
    // one and must not seed the new round's gates.
    const store = await seed((session) => {
      session.loopRuns['run-1'] = loopRun({ round: 2 });
      session.verdictProvenance['call-late'] = { runId: 'run-1', round: 1 };
    });

    const hooks = createRuntime(pluginInput()) as Hooks;
    const told = await report(hooks, 's1', 'call-late', 'review', 'pass', 'reviewer');

    const after = await load(store);
    expect(told).toContain('[workflow-result-stale]');
    expect(record(after!, 'run-1').gates).toEqual({});
    expect(after?.verifications).toEqual([]);
  });
});

describe('the verdict’s admission checks still hold', () => {
  test('refuses a verdict from an agent the gate’s stage does not allow', async () => {
    const store = await seed((session) => {
      session.loopRuns['run-1'] = loopRun();
      session.activeOperations['call-agent'] = {
        callId: 'call-agent',
        runId: 'run-1',
        taskId: 'task-1',
        agent: 'code',
        status: 'running',
        startedAt: new Date().toISOString(),
        round: 0,
        kind: 'task',
      };
      session.verdictProvenance['call-agent'] = { runId: 'run-1', round: 0 };
    });

    const hooks = createRuntime(pluginInput()) as Hooks;
    const told = await report(hooks, 's1', 'call-agent', 'review', 'pass', 'code');

    const after = await load(store);
    expect(told).toContain('[workflow-result-rejected]');
    expect(record(after!, 'run-1').gates).toEqual({});
    expect(after?.verifications).toEqual([]);
  });

  test('refuses a gate the stage did not declare', async () => {
    const store = await seed((session) => {
      session.loopRuns['run-1'] = loopRun();
      session.activeOperations['call-undeclared'] = {
        callId: 'call-undeclared',
        runId: 'run-1',
        taskId: 'task-1',
        agent: 'reviewer',
        status: 'running',
        startedAt: new Date().toISOString(),
        round: 0,
        kind: 'task',
      };
      session.verdictProvenance['call-undeclared'] = { runId: 'run-1', round: 0 };
    });

    const hooks = createRuntime(pluginInput()) as Hooks;
    const told = await report(hooks, 's1', 'call-undeclared', 'security', 'pass', 'reviewer');

    const after = await load(store);
    expect(told).toContain('[workflow-result-rejected]');
    expect(record(after!, 'run-1').gates).toEqual({});
  });

  test('records one verdict per call — a replay is refused', async () => {
    const store = await seed((session) => {
      session.loopRuns['run-1'] = loopRun();
      session.activeOperations['call-replay'] = {
        callId: 'call-replay',
        runId: 'run-1',
        taskId: 'task-1',
        agent: 'reviewer',
        status: 'running',
        startedAt: new Date().toISOString(),
        round: 0,
        kind: 'task',
      };
      session.verdictProvenance['call-replay'] = { runId: 'run-1', round: 0 };
    });

    const hooks = createRuntime(pluginInput()) as Hooks;
    await report(hooks, 's1', 'call-replay', 'review', 'pass', 'reviewer');
    const told = await report(hooks, 's1', 'call-replay', 'review', 'pass', 'reviewer');

    const after = await load(store);
    expect(told).toContain('[workflow-result-replayed]');
    expect(record(after!, 'run-1').gates).toEqual({ review: 'passed' });
    expect(after?.verifications).toHaveLength(1);
  });
});
