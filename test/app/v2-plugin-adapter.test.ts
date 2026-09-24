import { describe, expect, test } from 'bun:test';
import type { Context } from '@opencode/plugin/promise/plugin';
import { SessionGuardPluginV2 } from '../../src/index.ts';

describe('V2 plugin setup adapter', () => {
  test('registers execute.before and disposes the registration and runtime once', async () => {
    let callback:
      | ((event: {
          tool: string;
          sessionID: string;
          agent: string;
          messageID: string;
          id: string;
          input: unknown;
        }) => Promise<void>)
      | undefined;
    let disposed = 0;
    const context = {
      location: {
        directory: '/tmp/session-guard-worktree',
        project: { directory: '/tmp/session-guard-project' },
      },
      session: {},
      tool: {
        hook: async (_name: 'execute.before', handler: typeof callback) => {
          callback = handler;
          return {
            dispose: async () => {
              disposed += 1;
            },
          };
        },
      },
    } as unknown as Context;

    const cleanup = await SessionGuardPluginV2(context);
    expect(callback).toBeDefined();
    await cleanup();
    await cleanup();
    expect(disposed).toBe(1);
  });

  test('disposes the runtime when registration fails during setup', async () => {
    const context = {
      location: {
        directory: '/tmp/session-guard-worktree-failure',
        project: { directory: '/tmp/session-guard-project-failure' },
      },
      session: {},
      tool: {
        hook: async () => {
          throw new Error('registration failed');
        },
      },
    } as unknown as Context;

    await expect(SessionGuardPluginV2(context)).rejects.toThrow('registration failed');
  });

  test('still disposes the runtime when registration disposal fails', async () => {
    let disposed = 0;
    const context = {
      location: {
        directory: '/tmp/session-guard-disposal-failure-worktree',
        project: { directory: '/tmp/session-guard-disposal-failure-project' },
      },
      session: {},
      tool: {
        hook: async () => ({
          dispose: async () => {
            disposed += 1;
            throw new Error('registration disposal failed');
          },
        }),
      },
    } as unknown as Context;

    const cleanup = await SessionGuardPluginV2(context);
    await expect(cleanup()).rejects.toThrow('registration disposal failed');
    expect(disposed).toBe(1);
  });
});
