import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';

type Logged = { level: string; message: string };
type Toasted = { message: string };

let storeDirectory: string;
let profilesDirectory: string;
let projectDirectory: string;
let logged: Logged[];
let toasted: Toasted[];
let previousStore: string | undefined;
let previousProfiles: string | undefined;
let previousLevel: string | undefined;
let previousDebugTui: string | undefined;

function pluginInput(): PluginInput {
  const client = {
    app: {
      log: async (input: { body: { level: string; message: string } }) => {
        logged.push({ level: input.body.level, message: input.body.message });
      },
    },
    post: async (path: string, input: { body: { message: string } }) => {
      if (path === '/tui/show-toast') toasted.push({ message: input.body.message });
    },
  };
  return {
    client: client as unknown as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: projectDirectory,
      worktree: projectDirectory,
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: projectDirectory,
    worktree: projectDirectory,
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

/** A profile whose schema compiles with an error: a loop has no stages. */
function seedBrokenProfile(): void {
  const dir = join(profilesDirectory, 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'profile.json'),
    JSON.stringify({ id: 'broken', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  writeFileSync(
    join(dir, 'cycle.yaml'),
    [
      'stages:',
      '  execution:',
      '    loop: implementation',
      '    transitions:',
      '      - from: code',
      '        to: done',
      '',
    ].join('\n'),
    'utf-8'
  );
}

beforeEach(() => {
  logged = [];
  toasted = [];
  previousStore = process.env.SESSION_GUARD_STORE_DIR;
  previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
  previousLevel = process.env.SESSION_GUARD_LOG_LEVEL;
  previousDebugTui = process.env.DEBUG_TUI;
  storeDirectory = mkdtempSync(join(tmpdir(), 'funnel-store-'));
  profilesDirectory = mkdtempSync(join(tmpdir(), 'funnel-profiles-'));
  projectDirectory = mkdtempSync(join(tmpdir(), 'funnel-project-'));
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  process.env.SESSION_GUARD_PROFILES_DIR = profilesDirectory;
});

afterEach(() => {
  for (const [key, value] of [
    ['SESSION_GUARD_STORE_DIR', previousStore],
    ['SESSION_GUARD_PROFILES_DIR', previousProfiles],
    ['SESSION_GUARD_LOG_LEVEL', previousLevel],
    ['DEBUG_TUI', previousDebugTui],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(storeDirectory, { recursive: true, force: true });
  rmSync(profilesDirectory, { recursive: true, force: true });
  rmSync(projectDirectory, { recursive: true, force: true });
});

async function seedBrokenSession(): Promise<WorkflowStore> {
  seedBrokenProfile();
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'broken', 'cycle');
  session.tasks.implementation = [createTask()];
  await store.save(session);
  return store;
}

describe('every error the plugin reports takes one path', () => {
  it('turns a broken profile into readable tool output instead of a raw throw', async () => {
    // `tasks-get` is open to any caller and caught its own errors, while the
    // task-control tools resolved the engine before their handler's own try —
    // so the same ProfileConfigurationError escaped `workflow-tasks-set` raw
    // and became tool output next door. What the operator saw depended on
    // which tool they happened to call.
    await seedBrokenSession();
    const hooks = createRuntime(pluginInput()) as Hooks & {
      tool?: Record<string, { execute: (a: unknown, c: unknown) => Promise<{ output: string }> }>;
    };

    const result = await hooks.tool!['workflow-tasks-set']!.execute(
      { tasks: [] },
      { sessionID: 's1', agent: 'orchestrator' }
    );

    expect(result.output).toContain('workflow-tasks-set is refused');
    expect(result.output).toContain('declares no stages to run');
  });

  it('logs every refusal at error level', async () => {
    await seedBrokenSession();
    const hooks = createRuntime(pluginInput()) as Hooks & {
      tool?: Record<string, { execute: (a: unknown, c: unknown) => Promise<{ output: string }> }>;
    };

    await hooks.tool!['workflow-tasks-set']!.execute(
      { tasks: [] },
      { sessionID: 's1', agent: 'orchestrator' }
    );

    expect(logged.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('shows a toast only when debug is on, through the one switch', async () => {
    delete process.env.SESSION_GUARD_LOG_LEVEL;
    await seedBrokenSession();
    const quiet = createRuntime(pluginInput()) as Hooks & {
      tool?: Record<string, { execute: (a: unknown, c: unknown) => Promise<{ output: string }> }>;
    };
    await quiet.tool!['workflow-tasks-set']!.execute(
      { tasks: [] },
      { sessionID: 's1', agent: 'orchestrator' }
    );
    expect(toasted).toEqual([]);

    process.env.SESSION_GUARD_LOG_LEVEL = 'debug';
    const loud = createRuntime(pluginInput()) as Hooks & {
      tool?: Record<string, { execute: (a: unknown, c: unknown) => Promise<{ output: string }> }>;
    };
    await loud.tool!['workflow-tasks-set']!.execute(
      { tasks: [] },
      { sessionID: 's1', agent: 'orchestrator' }
    );
    expect(toasted.map((t) => t.message).join('\n')).toContain('declares no stages to run');
  });

  it('reports a refused tool call as well as throwing it', async () => {
    process.env.SESSION_GUARD_LOG_LEVEL = 'debug';
    await seedBrokenSession();
    const hooks = createRuntime(pluginInput());

    await expect(
      hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 's1', callID: 'c1' },
        { args: { subagent_type: 'code', description: '[workflow-task:task-1] work' } }
      )
    ).rejects.toThrow();

    expect(logged.some((entry) => entry.level === 'error')).toBe(true);
    expect(toasted.length).toBeGreaterThan(0);
  });
});
