import { describe, expect, test } from 'bun:test';
import type { Context } from '@opencode/plugin/promise/plugin';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionGuardPluginV2 } from '../../src/index.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';

type BeforeEvent = {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
};

type BeforeCallback = (event: BeforeEvent) => Promise<void>;

type AfterEvent = BeforeEvent &
  (
    | { status: 'completed'; result: { output?: unknown; content?: unknown; metadata?: unknown } }
    | { status: 'error'; error: { message: string; error?: unknown; metadata?: unknown } }
  );

type AfterCallback = (event: AfterEvent) => Promise<void>;

function v2Context(
  onHook: (
    name: 'execute.before' | 'execute.after',
    callback: BeforeCallback | AfterCallback
  ) => void
): Context {
  return {
    location: {
      directory: '/tmp/session-guard-worktree',
      project: { directory: '/tmp/session-guard-project' },
    },
    tool: {
      hook: async (
        name: 'execute.before' | 'execute.after',
        callback: BeforeCallback | AfterCallback
      ) => {
        onHook(name, callback);
        return { dispose: async () => {} };
      },
    },
  } as unknown as Context;
}

function executionSession(sessionID: string) {
  const session = createSession(sessionID, 'test-profile', 'cycle');
  session.currentStage = 'EXECUTION';
  session.tasks.implementation = [createTask()];
  return session;
}

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
    expect(disposed).toBe(2);
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

  test('disposes the before registration when after registration fails during setup', async () => {
    let beforeDisposals = 0;
    let registrations = 0;
    const context = {
      location: {
        directory: '/tmp/session-guard-partial-worktree',
        project: { directory: '/tmp/session-guard-partial-project' },
      },
      session: {},
      tool: {
        hook: async () => {
          registrations += 1;
          if (registrations === 2) throw new Error('after registration failed');
          return {
            dispose: async () => {
              beforeDisposals += 1;
            },
          };
        },
      },
    } as unknown as Context;

    await expect(SessionGuardPluginV2(context)).rejects.toThrow('after registration failed');
    expect(beforeDisposals).toBe(1);
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
    expect(disposed).toBe(2);
  });

  test('rejects a disallowed V2 operation without mutating an unrelated workflow session', async () => {
    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
    const storeDirectory = await mkdtemp(join(tmpdir(), 'v2-before-store-'));
    process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
    process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../fixtures/profiles');

    try {
      const store = new WorkflowStore(storeDirectory);
      const blocked = executionSession('blocked-session');
      blocked.tasks.implementation = [createTask({ status: 'running' })];
      blocked.loopRuns['run-1'] = {
        id: 'run-1',
        taskId: 'task-1',
        listKey: 'implementation',
        ancestry: [],
        stage: 'dev',
        status: 'running',
        gates: {},
        round: 0,
      };
      blocked.activeOperations['existing-call'] = {
        callId: 'existing-call',
        runId: 'run-1',
        taskId: 'task-1',
        agent: 'code',
        startedAt: new Date().toISOString(),
        status: 'running',
        round: 0,
        kind: 'task',
      };
      await store.save(blocked);
      await store.save(executionSession('unrelated-session'));

      let callback: BeforeCallback | undefined;
      const cleanup = await SessionGuardPluginV2(
        v2Context((name, registered) => {
          if (name === 'execute.before') callback = registered as BeforeCallback;
        })
      );

      await expect(
        callback!({
          tool: 'task',
          sessionID: 'blocked-session',
          agent: 'code',
          messageID: 'message-1',
          id: 'blocked-call',
          input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
        })
      ).rejects.toThrow();

      expect(
        (await store.load('blocked-session'))?.activeOperations['blocked-call']
      ).toBeUndefined();
      expect((await store.load('unrelated-session'))?.activeOperations).toEqual({});
      await cleanup();
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
      else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });

  test('forwards an allowed V2 operation with optional identity fields unchanged', async () => {
    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
    const storeDirectory = await mkdtemp(join(tmpdir(), 'v2-before-allowed-store-'));
    process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
    process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../fixtures/profiles');

    try {
      const store = new WorkflowStore(storeDirectory);
      await store.save(executionSession('allowed-session'));
      let callback: BeforeCallback | undefined;
      const cleanup = await SessionGuardPluginV2(
        v2Context((name, registered) => {
          if (name === 'execute.before') callback = registered as BeforeCallback;
        })
      );

      await expect(
        callback!({
          tool: 'task',
          sessionID: 'allowed-session',
          agent: 'code',
          messageID: 'message-2',
          id: 'allowed-call',
          input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
        })
      ).resolves.toBeUndefined();

      expect((await store.load('allowed-session'))?.activeOperations['allowed-call']).toMatchObject(
        {
          callId: 'allowed-call',
          agent: 'code',
        }
      );
      await cleanup();
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
      else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });

  test('closes only the matching lifecycle for completed and error after events', async () => {
    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
    const storeDirectory = await mkdtemp(join(tmpdir(), 'v2-after-store-'));
    process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
    process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../fixtures/profiles');

    try {
      const store = new WorkflowStore(storeDirectory);
      await store.save(executionSession('completed-session'));
      await store.save(executionSession('error-session'));
      await store.save(executionSession('unrelated-session'));
      let before: BeforeCallback | undefined;
      let after: AfterCallback | undefined;
      const cleanup = await SessionGuardPluginV2(
        v2Context((name, registered) => {
          if (name === 'execute.before') before = registered as BeforeCallback;
          else after = registered as AfterCallback;
        })
      );

      await before!({
        tool: 'task',
        sessionID: 'completed-session',
        agent: 'code',
        messageID: 'message-completed',
        id: 'completed-call',
        input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
      });
      await before!({
        tool: 'task',
        sessionID: 'error-session',
        agent: 'code',
        messageID: 'message-error',
        id: 'error-call',
        input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
      });

      await after!({
        tool: 'task',
        sessionID: 'completed-session',
        agent: 'code',
        messageID: 'message-completed',
        id: 'completed-call',
        input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
        status: 'completed',
        result: { output: '<workflow-result>completed</workflow-result>', metadata: {} },
      });
      await after!({
        tool: 'task',
        sessionID: 'error-session',
        agent: 'code',
        messageID: 'message-error',
        id: 'error-call',
        input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
        status: 'error',
        error: { message: 'tool failed', metadata: { failed: false } },
      });
      await after!({
        tool: 'task',
        sessionID: 'completed-session',
        agent: 'code',
        messageID: 'message-stale',
        id: 'stale-call',
        input: {},
        status: 'error',
        error: { message: 'stale failure' },
      });

      expect(
        (await store.load('completed-session'))?.activeOperations['completed-call']
      ).toBeUndefined();
      expect((await store.load('error-session'))?.activeOperations['error-call']).toBeUndefined();
      expect((await store.load('error-session'))?.loopRuns['run-1']?.checks).toBe('failed');
      expect((await store.load('unrelated-session'))?.activeOperations).toEqual({});
      await cleanup();
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
      else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });
});
