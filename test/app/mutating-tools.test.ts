import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';

/**
 * Every tool that changes the repository runs under the mutation lifecycle.
 *
 * `edit` and `apply_patch` write files exactly as `write` does. Handling only
 * `bash` and `write` let an agent edit a file it was not allowed to create:
 * the plan approval was never checked and the invariants were never re-run.
 */

let storeDirectory: string;
let profilesDirectory: string;
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

beforeEach(async () => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'mutating-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'mutating-profiles-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;

  // `mutation-guarded` admits nothing until a plan is approved.
  process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');

  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'mutation-guarded');
  session.currentStage = 'planning';
  await store.save(session);
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
});

/** Run a tool's before-hook and return the refusal, if any. */
async function attempt(hooks: Hooks, tool: string): Promise<string> {
  try {
    await hooks['tool.execute.before']!(
      { tool, sessionID: 's1', callID: `call-${tool}` },
      { args: { filePath: 'src/a.ts', content: 'x' } }
    );
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('an unapproved plan blocks every tool that changes the repository', () => {
  for (const tool of ['write', 'edit', 'apply_patch', 'bash']) {
    it(`refuses ${tool}`, async () => {
      const hooks = createRuntime(pluginInput());
      expect(
        await attempt(hooks, tool),
        `${tool} edited a repository with no approved plan`
      ).not.toBe('');
    });
  }

  it('lets a read through — reading changes nothing', async () => {
    const hooks = createRuntime(pluginInput());
    expect(await attempt(hooks, 'read')).toBe('');
  });
});
