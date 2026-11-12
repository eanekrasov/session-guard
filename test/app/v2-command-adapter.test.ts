import { describe, expect, test } from 'bun:test';
import type { AgentEditor } from '@opencode/plugin/promise/agent';
import type { CommandDefinition, CommandEditor } from '@opencode/plugin/promise/command';
import type { Context } from '@opencode/plugin/promise/plugin';
import { Session } from '@opencode/schema/session';
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
  capture: CommandDefinition[],
  prompt: (
    input: Parameters<Context['session']['prompt']>[0]
  ) => Promise<unknown> = async () => ({})
) {
  return {
    location: { directory: '/tmp', project: { directory: '/tmp' } },
    command: {
      list: async () => ({ location: { directory: '/tmp' }, data: [] }),
      transform: async (callback: (editor: Pick<CommandEditor, 'add'>) => void) => {
        callback({ add: (definition) => capture.push(definition) });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    session: { prompt },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (_callback: (editor: Pick<AgentEditor, 'update'>) => void) => {
        // agent transform — no-op default; tests that need it override ctx.agent.transform
      },
      reload: async () => {},
    },
  };
}

function minContext() {
  return {
    location: { directory: '/tmp', project: { directory: '/tmp' } },
    command: {
      list: async () => ({ location: { directory: '/tmp' }, data: [] }),
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
    session: { prompt: async () => ({}) },
    agent: {
      list: async () => ({ data: [] }),
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
  };
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
      const added: CommandDefinition[] = [];
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
      const added: CommandDefinition[] = [];
      let promptInput: unknown;
      const sessionID = Session.ID.create();
      const ctx = contextWithCommandCapture(added, async (input) => {
        promptInput = input;
      });

      await registerV2Commands(ctx);
      await added[0]!.execute({
        sessionID,
        prompt: { text: 'unused' },
        delivery: 'queue',
      });

      expect(promptInput).toEqual({
        sessionID,
        text: 'tell the user the current session-guard workflow status for this session',
        delivery: 'queue',
      });
    });

    test('forwards host prompt failures unchanged', async () => {
      const added: CommandDefinition[] = [];
      const failure = new Error('prompt failed');
      const ctx = contextWithCommandCapture(added, async () => {
        throw failure;
      });

      await registerV2Commands(ctx);
      await expect(
        added[0]!.execute({
          sessionID: Session.ID.create(),
          prompt: { text: 'unused' },
          delivery: 'steer',
        })
      ).rejects.toBe(failure);
    });
  });

  describe('registerV2Agent', () => {
    test('updates the session-guard agent when it already exists', async () => {
      let updatedId: string | undefined;
      const ctx = {
        ...minContext(),
        agent: {
          transform: async (callback: (editor: Pick<AgentEditor, 'update'>) => void) => {
            callback({
              update: (id) => {
                updatedId = id;
              },
            });
            return { dispose: async () => {} };
          },
        },
      };

      await registerV2Agent(ctx);
      expect(updatedId).toBe('session-guard');
    });

    test('does not throw when agent is absent', async () => {
      const ctx = {
        ...minContext(),
        agent: {
          transform: async (callback: (editor: Pick<AgentEditor, 'update'>) => void) => {
            callback({
              update: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      };

      await expect(registerV2Agent(ctx)).resolves.toBeDefined();
    });
  });

  describe('createV2CommandAdapter', () => {
    test('returns registrations without throwing', async () => {
      const added: CommandDefinition[] = [];
      const ctx = {
        ...minContext(),
        command: {
          ...minContext().command,
          transform: async (callback: (editor: Pick<CommandEditor, 'add'>) => void) => {
            callback({
              add: (def) => added.push(def),
            });
            return { dispose: async () => {} };
          },
        },
        agent: {
          ...minContext().agent,
          transform: async (callback: (editor: Pick<AgentEditor, 'update'>) => void) => {
            callback({
              update: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      };
      const result = await createV2CommandAdapter(ctx);
      expect(result.registrations).toBeDefined();
      expect(result.registrations).toHaveLength(1);
      for (const reg of result.registrations) {
        expect(typeof reg.dispose).toBe('function');
      }
    });

    test('all registrations are disposable without error', async () => {
      const added: CommandDefinition[] = [];
      const ctx = {
        ...minContext(),
        command: {
          ...minContext().command,
          transform: async (callback: (editor: Pick<CommandEditor, 'add'>) => void) => {
            callback({
              add: (def) => added.push(def),
            });
            return { dispose: async () => {} };
          },
        },
        agent: {
          ...minContext().agent,
          transform: async (callback: (editor: Pick<AgentEditor, 'update'>) => void) => {
            callback({
              update: () => {},
            });
            return { dispose: async () => {} };
          },
        },
      };
      const result = await createV2CommandAdapter(ctx);
      for (const reg of result.registrations) {
        await expect(reg.dispose()).resolves.toBeUndefined();
      }
    });
  });
});
