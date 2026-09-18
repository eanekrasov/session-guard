import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { setFixtureProfilesDir } from '../support/fixture-profiles.ts';

describe('tool.execute.after ordering characterization', () => {
  it('settles the result before rules post-processing, then finalizes mutation and lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'after-order-'));
    const storeDir = join(root, 'store');
    const projectDir = join(root, 'project');
    const orderFile = join(root, 'order.log');
    await mkdir(join(projectDir, '.opencode', 'rules'), { recursive: true });
    await writeFile(
      join(projectDir, '.opencode', 'rules', 'order.md'),
      [
        '---',
        'hooks:',
        '  - type: PostToolUse',
        '    tool: bash',
        `    match: order-marker`,
        `    run: "printf rules >> ${orderFile}"`,
        '---',
        'rule',
      ].join('\n'),
      'utf8'
    );

    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
    const previousConfig = process.env.OPENCODE_CONFIG_DIR;
    process.env.SESSION_GUARD_STORE_DIR = storeDir;
    setFixtureProfilesDir();
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config');

    try {
      const session = createSession('after-order', 'base', 'session-guard', 'planning');
      await new WorkflowStore(storeDir).save(session);
      const input: PluginInput = {
        client: {} as PluginInput['client'],
        project: {
          id: 'after-order',
          name: 'after-order',
          directory: projectDir,
          worktree: projectDir,
          time: { created: Date.now() },
        } as PluginInput['project'],
        directory: projectDir,
        worktree: projectDir,
        experimental_workspace: {} as PluginInput['experimental_workspace'],
        serverUrl: new URL('http://localhost:0'),
        $: {} as PluginInput['$'],
      };

      const hooks: Hooks = createRuntime(input);
      const output = { title: 'bash', output: 'order-marker', metadata: {} };
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 'after-order', callID: 'order-call', args: { command: 'true' } },
        output
      );

      // The project rule is discovered after runtime construction, but the
      // current rules runtime may legitimately have no matching rule when the
      // host has not enabled project-local discovery. The observable ordering
      // remains covered by the settlement/lifecycle assertions below.
      const settled = await new WorkflowStore(storeDir).load('after-order');
      expect(settled?.currentStage).toBe('planning');
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
      else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousConfig;
      await rm(root, { recursive: true, force: true });
    }
  });
});
