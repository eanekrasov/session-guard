import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession, MutationTask } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

/**
 * task-scope spec, CRITICAL-2 remediation: the non-overlap check MUST apply
 * to every non-serial dispatch strategy, not just `parallel`. Under
 * `serial_with_overlap` the second task is only ordering-eligible once the
 * first has left the entry stage — that alone must not be enough to admit
 * it when its writeScope overlaps a still-running task's writeScope.
 */

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

let overlapProfileId = 'cycle-overlap-2';

function setOverlapFixtureProfilesDir(maxConcurrent = 2): void {
  setFixtureProfilesDir();
  overlapProfileId = maxConcurrent === 1 ? 'cycle-overlap-1' : 'cycle-overlap-2';
}

async function seed(
  taskA: Partial<MutationTask>,
  taskB: Partial<MutationTask>
): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', overlapProfileId, 'cycle');
  session.tasks.implementation = [createTask(taskA), createTask({ id: 'task-2', ...taskB })];
  await store.save(session);
  return store;
}

async function beforeTask(
  hooks: Hooks,
  callID: string,
  description: string,
  agent = 'code'
): Promise<{ blockedReason?: string }> {
  let blockedReason: string | undefined;
  try {
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: 's1', callID },
      { args: { subagent_type: agent, description } }
    );
  } catch (err) {
    blockedReason = err instanceof Error ? err.message : String(err);
  }
  return { blockedReason };
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
  previousStoreDirectory = process.env.SESSION_GUARD_STORE_DIR;
  previousProfilesDirectory = process.env.SESSION_GUARD_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'overlap-scope-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'overlap-scope-profiles-'));
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  process.env.SESSION_GUARD_PROFILES_DIR = profilesDirectory;
});

afterEach(async () => {
  if (previousStoreDirectory === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
  else process.env.SESSION_GUARD_STORE_DIR = previousStoreDirectory;
  if (previousProfilesDirectory === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
  else process.env.SESSION_GUARD_PROFILES_DIR = previousProfilesDirectory;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
});

describe('non-overlapping writeScope also applies to serial_with_overlap admission', () => {
  it('rejects the ordering-eligible next task when its writeScope overlaps the running task', async () => {
    setOverlapFixtureProfilesDir();
    const store = await seed(
      { writeScope: ['src/auth/**'] },
      { writeScope: ['src/auth/login.ts'] }
    );
    const hooks: Hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    // task-1 leaves the entry stage (dev -> review), satisfying ordering.
    await afterTask(hooks, 'call-1', workflowResult('review', 'pass'));

    const admitted = await beforeTask(hooks, 'call-2', '[workflow-task:task-2] Second');
    const session = await load(store);

    // Ordering alone would admit task-2 here (this is exactly what the
    // pre-existing "allows serial_with_overlap next dev only after the
    // prior run leaves dev" test proves for non-overlapping scopes). The
    // overlap with task-1's still-open writeScope must still reject it.
    expect(admitted.blockedReason).toEqual(expect.any(String));
    expect(admitted.blockedReason).toMatch(/writeScope overlaps/);
    expect(Object.keys(session.activeOperations)).toEqual([]);
  });

  it('still admits the ordering-eligible next task when its writeScope is disjoint', async () => {
    setOverlapFixtureProfilesDir();
    const store = await seed({ writeScope: ['src/auth/**'] }, { writeScope: ['src/billing/**'] });
    const hooks: Hooks = createRuntime(pluginInput());

    await beforeTask(hooks, 'call-1', '[workflow-task:task-1] First');
    await afterTask(hooks, 'call-1', workflowResult('review', 'pass'));

    const admitted = await beforeTask(hooks, 'call-2', '[workflow-task:task-2] Second');
    const session = await load(store);

    expect(admitted.blockedReason).toBeUndefined();
    expect(session.activeOperations['call-2']?.taskId).toBe('task-2');
  });
});
