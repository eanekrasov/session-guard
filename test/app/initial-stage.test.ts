import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { WorkflowStore } from '../../src/session/session-store.ts';
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
  { execute: (_args: unknown, _ctx: unknown) => Promise<{ output: string }> }
>;

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'initial-stage-'));
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

describe("a session starts in its own workflow's first stage", () => {
  it('creates a start → done session in start, not in planning', async () => {
    // `createSession` wrote the literal 'planning' — the base profile's first
    // stage, hardcoded into the core. A schema declaring `start → done`
    // reported a successful create and then sat in a stage it does not
    // declare: no outgoing edge, no admission, and no error to say why. The
    // compiler had worked the right answer out all along and nobody read it.
    const hooks = createRuntime(pluginInput()) as Hooks & { tool?: ToolMap };
    const store = new WorkflowStore(storeDirectory);

    const result = await hooks.tool!['workflow.create']!.execute(
      { schemaId: 'start-done/flow' },
      { sessionID: 'starts-at-start' }
    );

    expect(result.output).toContain('Created session');

    const session = await store.load('starts-at-start');
    expect(session?.currentStage).toBe('start');
    // And the stage it starts in is one the schema actually declares.
    expect(['start', 'done']).toContain(session!.currentStage);
  });

  it('still starts a planning-first workflow in planning', async () => {
    const hooks = createRuntime(pluginInput()) as Hooks & { tool?: ToolMap };
    const store = new WorkflowStore(storeDirectory);

    await hooks.tool!['workflow.create']!.execute(
      { schemaId: 'base/state-machine' },
      { sessionID: 'starts-at-planning' }
    );

    expect((await store.load('starts-at-planning'))?.currentStage).toBe('planning');
  });
});
