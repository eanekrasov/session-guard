import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Config } from '@opencode-ai/plugin';
import type { PluginInput } from '@opencode-ai/plugin';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createPluginInput(): PluginInput {
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

function createEmptyConfig(): Config {
  return {
    $schema: '',
    model: 'anthropic/claude-sonnet-4-20250514',
  };
}

let prevHarnessProfile: string | undefined;
let prevStoreDir: string | undefined;

beforeEach(() => {
  prevHarnessProfile = process.env.HARNESS_PROFILE;
  prevStoreDir = process.env.STATE_MACHINE_STORE_DIR;
  process.env.STATE_MACHINE_STORE_DIR = '/tmp/state-machine-test-sessions';
});

afterEach(() => {
  if (prevHarnessProfile === undefined) delete process.env.HARNESS_PROFILE;
  else process.env.HARNESS_PROFILE = prevHarnessProfile;
  if (prevStoreDir === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = prevStoreDir;
});

describe('config hook', () => {
  it('registers sm-* commands and state-machine agent via config hook', async () => {
    const { createRuntime } = await import('../../src/app/runtime.ts');
    const hooks = createRuntime(createPluginInput());

    // config hook must exist
    expect(hooks.config).toBeDefined();
    expect(typeof hooks.config).toBe('function');

    // Call config hook with an empty config
    const config = createEmptyConfig();
    await hooks.config!(config);

    // Check commands
    expect(config.command).toBeDefined();
    expect(config.command!['sm-status']).toBeDefined();
    expect(config.command!['sm-status']!.template).toContain('state-machine workflow status');
    expect(config.command!['sm-status']!.agent).toBe('state-machine');
    expect(config.command!['sm-status']!.subtask).toBe(true);

    expect(config.command!['sm-list']).toBeDefined();
    expect(config.command!['sm-list']!.template).toContain('list all state-machine');
    expect(config.command!['sm-list']!.agent).toBe('state-machine');

    expect(config.command!['sm-session']).toBeDefined();
    expect(config.command!['sm-session']!.template).toContain(
      'manage the state-machine workflow session'
    );
    expect(config.command!['sm-session']!.agent).toBe('state-machine');

    expect(config.command!['sm-profile']).toBeDefined();
    expect(config.command!['sm-profile']!.template).toContain('switch the state-machine profile');
    expect(config.command!['sm-profile']!.agent).toBe('state-machine');
  });

  it('registers state-machine agent with correct config', async () => {
    const { createRuntime } = await import('../../src/app/runtime.ts');
    const hooks = createRuntime(createPluginInput());

    const config = createEmptyConfig();
    await hooks.config!(config);

    expect(config.agent).toBeDefined();
    expect(config.agent!['state-machine']).toBeDefined();
    expect(config.agent!['state-machine']!.description).toContain('State machine workflow agent');
    expect(config.agent!['state-machine']!.mode).toBe('subagent');
    expect(config.agent!['state-machine']!.color).toBe('#6366F1');
  });

  it('preserves existing commands when extending', async () => {
    const { createRuntime } = await import('../../src/app/runtime.ts');
    const hooks = createRuntime(createPluginInput());

    const config: Config = {
      $schema: '',
      model: 'anthropic/claude-sonnet-4-20250514',
      command: {
        'existing-cmd': {
          template: 'existing command',
          description: 'test',
          subtask: false,
        },
      },
      agent: {
        'existing-agent': {
          description: 'test',
          mode: 'subagent',
        },
      },
    };

    await hooks.config!(config);

    // Existing command preserved
    expect(config.command!['existing-cmd']).toBeDefined();
    expect(config.command!['existing-cmd']!.template).toBe('existing command');

    // New commands added
    expect(config.command!['sm-status']).toBeDefined();

    // Existing agent preserved
    expect(config.agent!['existing-agent']).toBeDefined();

    // New agent added
    expect(config.agent!['state-machine']).toBeDefined();
  });

  it('derives agent model from config.model', async () => {
    const { createRuntime } = await import('../../src/app/runtime.ts');
    const hooks = createRuntime(createPluginInput());

    const config = createEmptyConfig();
    config.model = 'openai/gpt-4o';

    await hooks.config!(config);

    expect(config.agent!['state-machine']!.model).toBe('openai/gpt-4o');
  });
});
