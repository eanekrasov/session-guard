import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('plugin entry point (R10)', () => {
  const prevStoreDir = process.env.STATE_MACHINE_STORE_DIR;

  beforeEach(() => {
    process.env.STATE_MACHINE_STORE_DIR =
      '/tmp/state-machine-test-bridge-' + Math.random().toString(36).slice(2);
  });

  afterEach(() => {
    if (prevStoreDir !== undefined) {
      process.env.STATE_MACHINE_STORE_DIR = prevStoreDir;
    } else {
      delete process.env.STATE_MACHINE_STORE_DIR;
    }
  });

  it('imports StateMachinePlugin as named and exposes the v1 module from src/index.ts', async () => {
    const mod = await import('../../src/index.ts');

    expect(mod).toBeDefined();
    expect(mod.StateMachinePlugin).toBeDefined();
    expect(typeof mod.StateMachinePlugin).toBe('function');
    expect(mod.default).toBeDefined();
    expect(mod.default.server).toBe(mod.StateMachinePlugin);
  });

  it('default export returns an object with Hooks shape', async () => {
    const { default: plugin } = await import('../../src/index.ts');

    const result = await plugin.server({
      client: {} as never,
      project: {
        id: 'test',
        name: 'test',
        directory: '/tmp/test',
        worktree: '/tmp/test',
        time: { created: Date.now() },
      } as never,
      directory: '/tmp/test',
      worktree: '/tmp/test',
      experimental_workspace: {} as never,
      serverUrl: new URL('http://localhost:0'),
      $: {} as never,
    });

    expect(result).toBeDefined();
    expect(typeof result.tool).toBe('object');
    expect(typeof result['chat.message']).toBe('function');
    expect(typeof result['tool.execute.before']).toBe('function');
    expect(typeof result['tool.execute.after']).toBe('function');
    expect(typeof result.event).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });
});
