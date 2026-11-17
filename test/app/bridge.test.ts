import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';

import { createOpencodeClient } from '@opencode-ai/sdk/client';

describe('plugin entry point (R10)', () => {
  const prevStoreDir = process.env.SESSION_GUARD_STORE_DIR;

  beforeEach(() => {
    process.env.SESSION_GUARD_STORE_DIR =
      '/tmp/session-guard-test-bridge-' + Math.random().toString(36).slice(2);
  });

  afterEach(() => {
    if (prevStoreDir !== undefined) {
      process.env.SESSION_GUARD_STORE_DIR = prevStoreDir;
    } else {
      delete process.env.SESSION_GUARD_STORE_DIR;
    }
  });

  it('imports SessionGuardPluginV1 as named and exposes the v1 module from src/v1/plugin.ts', async () => {
    const mod = await import('../../src/v1/plugin.ts');

    expect(mod).toBeDefined();
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  it('default export of the combined plugin module exposes server and setup hooks', async () => {
    const { default: plugin } = await import('../../src/plugin.ts');

    expect(plugin).toBeDefined();
    expect(typeof plugin.server).toBe('function');
    expect(typeof plugin.setup).toBe('function');
  });

  it('v1 factory returns a Hooks object with the runtime surface', async () => {
    const { default: SessionGuardPluginV1 } = await import('../../src/v1/plugin.ts');

    const input: PluginInput = {
      client: createOpencodeClient(),
      project: {
        id: 'test',
        worktree: '/tmp/test',
        time: { created: Date.now() },
      },
      directory: '/tmp/test',
      worktree: '/tmp/test',
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL('http://localhost:0'),
      $: Bun.$,
    };

    const result = await SessionGuardPluginV1(input);

    expect(result).toBeDefined();
    expect(typeof result.tool).toBe('object');
    expect(typeof result['chat.message']).toBe('function');
    expect(typeof result['tool.execute.before']).toBe('function');
    expect(typeof result['tool.execute.after']).toBe('function');
    expect(typeof result.event).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });
});
