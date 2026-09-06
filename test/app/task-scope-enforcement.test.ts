import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { MutationTask } from '../../src/session/session-schema.ts';
import { createTask } from '../support/task-factory.ts';

/**
 * task-scope spec: writeScope/readScope enforcement at tool.execute.before.
 */

let storeDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;
const cleanupDirs: string[] = [];

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

function setExecutableProfilesDir(): void {
  const profilesDir = mkdtempSync(join(tmpdir(), 'scope-enforce-profiles-'));
  cleanupDirs.push(profilesDir);
  const profileDir = join(profilesDir, 'test-profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({ id: 'test-profile', name: 'test-profile', schemas: ['state-machine.yaml'] }),
    'utf-8'
  );
  writeFileSync(
    join(profileDir, 'state-machine.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    dispatch:',
      '      strategy: serial',
      '    stages:',
      '      dev:',
      "        allowedAgents: ['code', 'reviewer']",
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDir;
}

async function dispatchTask(
  hooks: Hooks,
  sessionId: string,
  callID: string,
  agent = 'code'
): Promise<void> {
  await hooks['tool.execute.before']!(
    { tool: 'task', sessionID: sessionId, callID },
    { args: { subagent_type: agent, description: '[workflow-task:task-1] implement' } }
  );
}

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = mkdtempSync(join(tmpdir(), 'scope-enforce-store-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  rmSync(storeDirectory, { recursive: true, force: true });
  for (const directory of cleanupDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function seedSession(
  sessionId: string,
  taskOverrides: Partial<MutationTask> = {}
): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession(sessionId, 'test-profile');
  session.tasks.implementation = [createTask(taskOverrides)];
  await store.save(session);
  return store;
}

describe('writeScope is enforced before file-argument writes', () => {
  it('refuses a write outside the active task writeScope', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { writeScope: ['src/auth/**'] });
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 's1', callID: 'call-write' },
        { args: { filePath: 'src/other/config.ts', content: 'x' } }
      )
    ).rejects.toThrow();
  });

  it('admits a write inside the active task writeScope', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { writeScope: ['src/auth/**'] });
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'edit', sessionID: 's1', callID: 'call-edit' },
        { args: { filePath: 'src/auth/login.ts', oldString: 'a', newString: 'b' } }
      )
    ).resolves.toBeUndefined();
  });

  it('refuses every write when writeScope is absent (read-only task)', async () => {
    setExecutableProfilesDir();
    await seedSession('s1');
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'write', sessionID: 's1', callID: 'call-write' },
        { args: { filePath: 'src/anything.ts', content: 'x' } }
      )
    ).rejects.toThrow();
  });
});

describe('readScope is enforced for reading tools', () => {
  it('refuses a read outside the declared readScope', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { readScope: ['src/**'] });
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'read', sessionID: 's1', callID: 'call-read' },
        { args: { filePath: 'docs/other.md' } }
      )
    ).rejects.toThrow();
  });

  it('admits a read inside the declared readScope', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { readScope: ['src/**'] });
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'read', sessionID: 's1', callID: 'call-read' },
        { args: { filePath: 'src/a.ts' } }
      )
    ).resolves.toBeUndefined();
  });

  it('does not restrict reads when readScope is absent', async () => {
    setExecutableProfilesDir();
    await seedSession('s1');
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'read', sessionID: 's1', callID: 'call-read' },
        { args: { filePath: 'anywhere/at/all.md' } }
      )
    ).resolves.toBeUndefined();
  });
});

describe('editingAgents is enforced', () => {
  it('refuses dispatch to an agent not listed in editingAgents', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { editingAgents: ['code'] });
    const hooks: Hooks = createRuntime(pluginInput());

    await expect(dispatchTask(hooks, 's1', 'call-1', 'reviewer')).rejects.toThrow();
  });

  it('admits dispatch to an agent listed in editingAgents', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { editingAgents: ['code'] });
    const hooks: Hooks = createRuntime(pluginInput());

    await expect(dispatchTask(hooks, 's1', 'call-1', 'code')).resolves.toBeUndefined();
  });
});

describe('bash writes are not enforced before the fact', () => {
  it('does not block a bash call even though it carries no path argument', async () => {
    setExecutableProfilesDir();
    await seedSession('s1', { writeScope: ['src/auth/**'] });
    const hooks: Hooks = createRuntime(pluginInput());
    await dispatchTask(hooks, 's1', 'call-1');

    // bash has no path argument (only workdir) — scopeBefore cannot classify
    // it, so it is never refused here. Out-of-scope bash writes are caught
    // only after the fact, via the per-move baseline diff (move-invariants).
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'call-bash' },
        { args: { command: 'echo hi > src/other/file.ts', workdir: '.' } }
      )
    ).resolves.toBeUndefined();
  });
});
