import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

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
  {
    execute: (
      _args: unknown,
      _ctx: unknown
    ) => Promise<{ output: string; metadata?: Record<string, unknown> }>;
  }
>;

const TASKS = [{ title: 'do the work', status: 'pending' as const }];

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'task-list-'));
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

async function seed(
  sessionID: string,
  profileId: string,
  schemaId: string
): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  await store.save(createSession(sessionID, profileId, schemaId, 'planning'));
  return store;
}

function tools(): ToolMap {
  return (createRuntime(pluginInput()) as Hooks & { tool?: ToolMap }).tool!;
}

describe('the workflow says which task list it has', () => {
  it('fills the single list a schema declares, whatever it is called', async () => {
    // The fallback was the literal 'implementation' — the base profile's loop
    // source written into the core. A schema declaring `loop: jobs` was
    // refused with "Unknown task list: implementation" and could never be
    // started: no run exists until tasks are dispatched, and no tasks could be
    // set without a run.
    const store = await seed('jobs', 'jobs-loop', 'flow');

    const result = await tools()['workflow.tasks-set']!.execute(
      { tasks: TASKS },
      { sessionID: 'jobs', agent: 'orchestrator' }
    );

    expect(result.output).toContain('jobs');
    expect((await store.load('jobs'))?.tasks.jobs).toHaveLength(1);
  });

  it('asks which list when the schema declares several', async () => {
    await seed('ambiguous', 'two-loops', 'flow');

    const result = await tools()['workflow.tasks-set']!.execute(
      { tasks: TASKS },
      { sessionID: 'ambiguous', agent: 'orchestrator' }
    );

    expect(result.output).toContain('listKey is required');
    expect(result.output).toContain('jobs');
    expect(result.output).toContain('deliveries');
  });

  it('takes the list a caller names', async () => {
    const store = await seed('named', 'two-loops', 'flow');

    const result = await tools()['workflow.tasks-set']!.execute(
      { tasks: TASKS, listKey: 'deliveries' },
      { sessionID: 'named', agent: 'orchestrator' }
    );

    expect(result.output).toContain('deliveries');
    expect((await store.load('named'))?.tasks.deliveries).toHaveLength(1);
  });

  it('still refuses a list the workflow does not declare, and says what it has', async () => {
    await seed('wrong', 'jobs-loop', 'flow');

    const result = await tools()['workflow.tasks-set']!.execute(
      { tasks: TASKS, listKey: 'implementation' },
      { sessionID: 'wrong', agent: 'orchestrator' }
    );

    expect(result.output).toContain('Unknown task list: implementation');
    expect(result.output).toContain('jobs');
  });
});
