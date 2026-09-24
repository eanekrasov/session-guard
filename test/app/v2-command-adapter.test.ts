import { describe, expect, test } from 'bun:test';
import type { Context } from '@opencode/plugin/promise/plugin';
import {
  V1_SM_COMMANDS,
  V1_SESSION_GUARD_AGENT,
  V2_COMMAND_ADAPTER_BLOCKERS,
  createV2CommandAdapter,
  registerV2Commands,
  registerV2Agent,
  v1CommandToV2Definition,
} from '../../src/app/v2-command-adapter.ts';
import type { V1CommandDescriptor } from '../../src/app/v2-command-adapter.ts';

// ─── Helper: minimal Context stub with command transform ──────────────────────

function contextWithCommandCapture(
  capture: Array<{ name: string; description: string; execute: (input: unknown) => Promise<void> }>,
  prompt: (input: unknown) => Promise<void> = async () => {}
): Context {
  return {
    location: { directory: '/tmp', project: { directory: '/tmp' } },
    command: {
      list: async () => ({ location: { directory: '/tmp' }, data: [] }),
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (def: unknown) => {
            const d = def as {
              name: string;
              description: string;
              execute: (input: unknown) => Promise<void>;
            };
            capture.push(d);
          },
        });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    session: { prompt },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback: (editor: unknown) => void) => {
        // agent transform — no-op default; tests that need it override ctx.agent.transform
      },
      reload: async () => {},
    },
  } as unknown as Context;
}

function minContext(): Context {
  return {
    location: { directory: '/tmp', project: { directory: '/tmp' } },
    command: {
      list: async () => ({ location: { directory: '/tmp' }, data: [] }),
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
    agent: {
      list: async () => ({ data: [] }),
      transform: async () => undefined as unknown as Promise<never>,
      reload: async () => {},
    },
  } as unknown as Context;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('V2 command adapter', () => {
  describe('V1_SM_COMMANDS', () => {
    test('defines all four sm-* commands', () => {
      const names = V1_SM_COMMANDS.map((c) => c.name);
      expect(names).toEqual(['sm-status', 'sm-list', 'sm-session', 'sm-profile']);
    });

    test('each command has a description and template', () => {
      for (const cmd of V1_SM_COMMANDS) {
        expect(cmd.description).toBeTruthy();
        expect(cmd.template).toBeTruthy();
      }
    });
  });

  describe('V1_SESSION_GUARD_AGENT', () => {
    test('defines the session-guard agent descriptor', () => {
      expect(V1_SESSION_GUARD_AGENT).toMatchObject({
        id: 'session-guard',
        name: 'session-guard',
        description:
          'State machine workflow agent — manages sessions, profiles, stages, and gates. Use for sm-* commands.',
        mode: 'subagent',
        color: '#6366F1',
      });
    });
  });

  describe('v1CommandToV2Definition', () => {
    test('maps V1 descriptor to V2-compatible shape', () => {
      const v1: V1CommandDescriptor = {
        name: 'sm-status',
        description: 'Show status',
        template: 'tell the user the status',
      };
      const v2 = v1CommandToV2Definition(v1);
      expect(v2).toEqual({
        name: 'sm-status',
        description: 'Show status',
      });
    });
  });

  describe('V2_COMMAND_ADAPTER_BLOCKERS', () => {
    test('reports blockers for execute and agent creation', () => {
      expect(V2_COMMAND_ADAPTER_BLOCKERS.length).toBeGreaterThanOrEqual(2);
      expect(V2_COMMAND_ADAPTER_BLOCKERS.some((b) => b.includes('execute'))).toBe(true);
      expect(V2_COMMAND_ADAPTER_BLOCKERS.some((b) => b.includes('AgentEditor'))).toBe(true);
    });
  });

  describe('registerV2Commands', () => {
    test('registers four commands through ctx.command.transform', async () => {
      const added: Array<{
        name: string;
        description: string;
        execute: (input: unknown) => Promise<void>;
      }> = [];
      const ctx = contextWithCommandCapture(added);

      const reg = await registerV2Commands(ctx);
      expect(reg).toBeDefined();
      expect(typeof reg.dispose).toBe('function');
      expect(added).toHaveLength(4);
      expect(added[0]?.name).toBe('sm-status');
      expect(added.map((d) => d.name)).toEqual([
        'sm-status',
        'sm-list',
        'sm-session',
        'sm-profile',
      ]);
    });

    test('forwards the V1 prompt and delivery to the host session', async () => {
      const added: Array<{
        name: string;
        description: string;
        execute: (input: unknown) => Promise<void>;
      }> = [];
      let promptInput: unknown;
      const ctx = contextWithCommandCapture(added, async (input) => {
        promptInput = input;
      });

      await registerV2Commands(ctx);
      await added[0]!.execute({ sessionID: 'session-1', prompt: {}, delivery: 'queue' });

      expect(promptInput).toEqual({
        sessionID: 'session-1',
        text: 'tell the user the current session-guard workflow status for this session',
        delivery: 'queue',
      });
    });

    test('forwards host prompt failures unchanged', async () => {
      const added: Array<{
        name: string;
        description: string;
        execute: (input: unknown) => Promise<void>;
      }> = [];
      const failure = new Error('prompt failed');
      const ctx = contextWithCommandCapture(added, async () => {
        throw failure;
      });

      await registerV2Commands(ctx);
      await expect(
        added[0]!.execute({ sessionID: 'session-1', prompt: {}, delivery: 'steer' })
      ).rejects.toBe(failure);
    });
  });

  describe('registerV2Agent', () => {
    test('updates the session-guard agent when it already exists', async () => {
      let updatedId: string | undefined;
      const ctx = {
        ...minContext(),
        agent: {
          transform: async (callback: (editor: unknown) => void) => {
            callback({
              get: (id: string) =>
                id === 'session-guard'
                  ? ({ id, name: 'session-guard', mode: 'subagent' } as unknown as Record<
                      string,
                      unknown
                    >)
                  : undefined,
              update: (
                id: string,
                cb: (agent: { id: string; description: string; mode: 'subagent' }) => void
              ) => {
                updatedId = id;
                cb({ id, description: '', mode: 'subagent' });
              },
              list: () => [],
              default: () => {},
              remove: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      } as unknown as Context;

      await registerV2Agent(ctx);
      expect(updatedId).toBe('session-guard');
    });

    test('does not throw when agent is absent', async () => {
      const ctx = {
        ...minContext(),
        agent: {
          transform: async (callback: (editor: unknown) => void) => {
            callback({
              get: () => undefined,
              update: () => {},
              list: () => [],
              default: () => {},
              remove: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      } as unknown as Context;

      await expect(registerV2Agent(ctx)).resolves.toBeDefined();
    });
  });

  describe('createV2CommandAdapter', () => {
    test('returns registrations without throwing', async () => {
      const added: Array<{ name: string; description: string }> = [];
      const ctx = {
        ...minContext(),
        command: {
          ...minContext().command,
          transform: async (callback: (editor: unknown) => void) => {
            callback({
              add: (def: unknown) => added.push(def as { name: string; description: string }),
            });
            return { dispose: async () => {} };
          },
        },
        agent: {
          ...minContext().agent,
          transform: async (callback: (editor: unknown) => void) => {
            callback({
              get: () => undefined,
              update: () => {},
              list: () => [],
              default: () => {},
              remove: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      } as unknown as Context;
      const result = await createV2CommandAdapter(ctx);
      expect(result.registrations).toBeDefined();
      expect(result.registrations).toHaveLength(1);
      for (const reg of result.registrations) {
        expect(typeof reg.dispose).toBe('function');
      }
    });

    test('all registrations are disposable without error', async () => {
      const added: Array<{ name: string; description: string }> = [];
      const ctx = {
        ...minContext(),
        command: {
          ...minContext().command,
          transform: async (callback: (editor: unknown) => void) => {
            callback({
              add: (def: unknown) => added.push(def as { name: string; description: string }),
            });
            return { dispose: async () => {} };
          },
        },
        agent: {
          ...minContext().agent,
          transform: async (callback: (editor: unknown) => void) => {
            callback({
              get: () => undefined,
              update: () => {},
              list: () => [],
              default: () => {},
              remove: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      } as unknown as Context;
      const result = await createV2CommandAdapter(ctx);
      for (const reg of result.registrations) {
        await expect(reg.dispose()).resolves.toBeUndefined();
      }
    });
  });
});
