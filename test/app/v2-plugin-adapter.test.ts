import { afterAll, describe, expect, test } from 'bun:test';
import type { Context } from '@opencode/plugin/promise/plugin';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionGuardPluginV2 } from '../../src/index.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';
import { Effect } from 'effect';
import { v2ContextEvent, v2PromptEvent, v2HostEvent } from '../../src/app/v2-plugin-contract.ts';
import { calculateDocumentSetEvidence, evidenceOf } from '../../src/app/consent.ts';
import type { ConsentManifest } from '../../src/app/consent.ts';

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

const v2FixtureProject = mkdtempSync(join(tmpdir(), 'v2-fixture-project-'));
mkdirSync(join(v2FixtureProject, '.opencode'), { recursive: true });
symlinkSync(
  resolve(import.meta.dir, '../fixtures/profiles'),
  join(v2FixtureProject, '.opencode/profiles'),
  'dir'
);

afterAll(() => {
  rmSync(v2FixtureProject, { recursive: true, force: true });
});

function v2Context(
  onHook: (
    name: 'execute.before' | 'execute.after',
    callback: BeforeCallback | AfterCallback
  ) => void
): Context {
  return {
    location: {
      directory: v2FixtureProject,
      project: { directory: v2FixtureProject },
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

function v2ContextWithParents(
  parents: Record<string, string | undefined>,
  onHook: (
    name: 'execute.before' | 'execute.after',
    callback: BeforeCallback | AfterCallback
  ) => void,
  calls: Array<{ sessionID: string }>
): Context {
  const context = v2Context(onHook) as unknown as {
    session: { get(input: { sessionID: string }): Promise<{ parentID?: string }> };
  };
  context.session = {
    get: async ({ sessionID }) => {
      calls.push({ sessionID });
      return parents[sessionID] === undefined ? {} : { parentID: parents[sessionID] };
    },
  };
  return context as unknown as Context;
}

function executionSession(sessionID: string) {
  const session = createSession(sessionID, 'test-profile', 'cycle');
  session.currentStage = 'EXECUTION';
  session.tasks.implementation = [createTask()];
  return session;
}

describe('V2 plugin setup adapter', () => {
  test('maps supported V2 events to the V1 event payload', () => {
    expect(
      v2HostEvent({
        id: 'part-1',
        created: 1,
        type: 'message.part.updated',
        durable: { aggregateID: 'session-1', seq: 1, version: 2 },
        data: {
          sessionID: 'session-1',
          part: { id: 'part-1', type: 'text', text: 'updated' },
        },
      })
    ).toEqual({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { id: 'part-1', type: 'text', text: 'updated' },
        },
      },
    });
    expect(
      v2HostEvent({
        id: 'event-2',
        created: 2,
        type: 'message.removed',
        durable: { aggregateID: 'session-1', seq: 2, version: 2 },
        data: { sessionID: 'session-1', messageID: 'message-1' },
      })
    ).toEqual({
      event: {
        type: 'message.removed',
        properties: { sessionID: 'session-1', messageID: 'message-1' },
      },
    });
  });

  test('registers V2 events and disposes the subscription', async () => {
    let subscribeCalls = 0;
    let aborted = false;
    const context = {
      location: {
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
      },
      session: {},
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => {
          subscribeCalls += 1;
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>(() => {});
            },
          };
        },
      },
      tool: {
        hook: async () => ({ dispose: async () => {} }),
      },
    } as unknown as Context;

    const cleanup = await SessionGuardPluginV2(context);
    expect(subscribeCalls).toBe(1);
    await cleanup();
    expect(aborted).toBe(true);
  });

  test('maps the V2 context contract to the shared system transform contract', () => {
    expect(
      v2ContextEvent({
        sessionID: 'session-1',
        model: 'provider/model',
        agent: 'build',
        options: { temperature: 0.2 },
        messages: [],
        system: [{ type: 'text', text: 'base instructions' }],
      })
    ).toEqual({
      input: { sessionID: 'session-1', model: 'provider/model' },
      output: { system: ['base instructions'], messages: [] },
    });
  });

  test('registers the V2 context hook and disposes it with the runtime', async () => {
    let contextCallback:
      | ((event: {
          sessionID: string;
          model: string;
          agent: string;
          options: Record<string, unknown>;
          messages: Array<{
            role: 'user' | 'assistant' | 'system' | 'tool';
            content: Array<{ type: 'text'; text: string }>;
            id?: string;
          }>;
          system: Array<{ type: 'text'; text: string }>;
        }) => Promise<void>)
      | undefined;
    const disposed: string[] = [];
    const context = {
      location: {
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
      },
      session: {
        get: async () => ({}),
        hook: async (name: string, callback: unknown) => {
          if (name === 'context') contextCallback = callback as typeof contextCallback;
          return { dispose: async () => disposed.push('context') };
        },
      },
      tool: {
        hook: async (name: string) => ({ dispose: async () => disposed.push(name) }),
      },
    } as unknown as Context;

    const cleanup = await SessionGuardPluginV2(context);
    expect(contextCallback).toBeDefined();
    const event = {
      sessionID: 'missing-session',
      model: 'provider/model',
      agent: 'build',
      options: {},
      messages: [
        {
          id: 'message-1',
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'inspect src/app/runtime.ts' }],
        },
      ],
      system: [{ type: 'text' as const, text: 'base instructions' }],
    };
    await contextCallback!(event);
    expect(event.system).toEqual([{ type: 'text', text: 'base instructions' }]);
    expect(event.messages).toEqual([
      {
        id: 'message-1',
        role: 'user',
        content: [{ type: 'text', text: 'inspect src/app/runtime.ts' }],
      },
    ]);
    await cleanup();
    expect(disposed).toContain('context');
  });

  test('maps a prompt event to the shared chat message contract', () => {
    expect(
      v2PromptEvent({
        sessionID: 'session-1',
        messageID: 'message-1',
        prompt: { text: 'inspect src/app/runtime.ts' },
      })
    ).toEqual({
      input: { sessionID: 'session-1', messageID: 'message-1' },
      output: {
        message: { id: 'message-1', role: 'user' },
        parts: [{ type: 'text', text: 'inspect src/app/runtime.ts' }],
      },
    });
  });

  test('registers prompt and disposes it with the runtime', async () => {
    let promptCallback:
      | ((event: {
          sessionID: string;
          messageID: string;
          prompt: { text: string };
        }) => Promise<void>)
      | undefined;
    const disposed: string[] = [];
    const context = {
      location: {
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
      },
      session: {
        get: async () => ({}),
        hook: async (name: string, callback: unknown) => {
          if (name === 'prompt') promptCallback = callback as typeof promptCallback;
          return { dispose: async () => disposed.push(name) };
        },
      },
      tool: {
        hook: async (name: string) => ({ dispose: async () => disposed.push(name) }),
      },
    } as unknown as Context;

    const cleanup = await SessionGuardPluginV2(context);
    expect(promptCallback).toBeDefined();
    await promptCallback!({
      sessionID: 'prompt-session',
      messageID: 'prompt-message',
      prompt: { text: 'hello' },
    });
    await cleanup();
    expect(disposed).toContain('prompt');
  });

  test('registers and executes a read-only workflow-list tool per project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v2-workflow-list-'));
    const projectA = join(root, 'project-a');
    const projectB = join(root, 'project-b');
    await mkdir(join(projectA, '.opencode', 'profiles', 'alpha'), { recursive: true });
    await mkdir(join(projectB, '.opencode', 'profiles', 'beta'), { recursive: true });
    await writeFile(
      join(projectA, '.opencode', 'profiles', 'alpha', 'profile.json'),
      JSON.stringify({ id: 'alpha', description: 'Alpha profile', schemas: ['cycle.yaml'] })
    );
    await writeFile(
      join(projectB, '.opencode', 'profiles', 'beta', 'profile.json'),
      JSON.stringify({ id: 'beta', description: 'Beta profile', schemas: ['cycle.yaml'] })
    );

    const registrations: Array<{ dispose: () => Promise<void> }> = [];
    const tools: Array<{
      name: string;
      input: unknown;
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }> = [];
    const context = {
      location: { directory: projectA, project: { directory: projectA } },
      session: {},
      tool: {
        hook: async () => {
          const registration = { dispose: async () => {} };
          registrations.push(registration);
          return registration;
        },
        transform: async (
          callback: (editor: { add: (tool: (typeof tools)[number]) => void }) => void
        ) => {
          callback({ add: (tool) => tools.push(tool) });
          const registration = { dispose: async () => {} };
          registrations.push(registration);
          return registration;
        },
      },
    } as unknown as Context;

    const cleanup = await SessionGuardPluginV2(context);
    expect(tools).toHaveLength(7);
    const workflowList = tools.find((tool) => tool.name === 'workflow-list')!;
    expect(workflowList.input).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    const result = await Effect.runPromise(workflowList.execute({}, {}) as never);
    expect(result).toEqual({
      output:
        `profilesDir: ${join(projectA, '.opencode', 'profiles')}\n` +
        '  - alpha | desc: Alpha profile | schemas: cycle.yaml',
    });
    expect(registrations).toHaveLength(3);
    await cleanup();
    await cleanup();
    expect(registrations).toHaveLength(3);
    await rm(root, { recursive: true, force: true });
  });

  test('returns the empty profile result and maps listing errors to V2 errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v2-workflow-list-empty-'));
    const profileDirectory = join(root, '.opencode', 'profiles');
    await mkdir(profileDirectory, { recursive: true });
    const tools: Array<{
      name: string;
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }> = [];
    const context = {
      location: { directory: root, project: { directory: root } },
      session: {},
      tool: {
        hook: async () => ({ dispose: async () => {} }),
        transform: async (
          callback: (editor: { add: (value: (typeof tools)[number]) => void }) => void
        ) => {
          callback({ add: (value) => tools.push(value) });
          return { dispose: async () => {} };
        },
      },
    } as unknown as Context;
    try {
      const cleanup = await SessionGuardPluginV2(context);
      const tool = tools.find((value) => value.name === 'workflow-list')!;
      await expect(
        Effect.runPromise(tool.execute({}, { sessionID: 'list-session', agent: '' }) as never)
      ).resolves.toEqual({
        output: `profilesDir: ${profileDirectory}\n  (no profiles found)`,
      });
      await cleanup();
      await mkdir(join(profileDirectory, 'broken'), { recursive: true });
      await writeFile(join(profileDirectory, 'broken', 'profile.json'), '{');
      const second = await SessionGuardPluginV2(context);
      await expect(
        Effect.runPromise(tool.execute({}, { sessionID: 'list-session', agent: '' }) as never)
      ).rejects.toThrow('[ERROR] JSON Parse error');
      await second();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
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

  test('degrades safely when registration fails during setup', async () => {
    const context = {
      location: {
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
      },
      session: {},
      tool: {
        hook: async () => {
          throw new Error('registration failed');
        },
      },
    } as unknown as Context;

    await expect(SessionGuardPluginV2(context)).resolves.toBeFunction();
  });

  test('disposes the before registration and degrades when after registration fails during setup', async () => {
    let beforeDisposals = 0;
    let registrations = 0;
    const context = {
      location: {
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
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

    const cleanup = await SessionGuardPluginV2(context);
    expect(beforeDisposals).toBe(1);
    await cleanup();
  });

  test('still disposes the runtime when registration disposal fails', async () => {
    let disposed = 0;
    const context = {
      location: {
        directory: v2FixtureProject,
        project: { directory: v2FixtureProject },
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

  test('resolves a V2 child through ctx.session.get and mutates its workflow root', async () => {
    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
    const storeDirectory = await mkdtemp(join(tmpdir(), 'v2-parent-store-'));
    process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
    process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '../fixtures/profiles');

    try {
      const store = new WorkflowStore(storeDirectory);
      await store.save(executionSession('workflow-root'));
      const calls: Array<{ sessionID: string }> = [];
      let before: BeforeCallback | undefined;
      const cleanup = await SessionGuardPluginV2(
        v2ContextWithParents(
          { child: 'intermediate', intermediate: 'workflow-root' },
          (name, registered) => {
            if (name === 'execute.before') before = registered as BeforeCallback;
          },
          calls
        )
      );

      await before!({
        tool: 'task',
        sessionID: 'child',
        agent: 'code',
        messageID: 'message-child',
        id: 'child-call',
        input: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
      });

      expect(calls).toEqual([
        { sessionID: 'child' },
        { sessionID: 'intermediate' },
        { sessionID: 'workflow-root' },
      ]);
      expect((await store.load('workflow-root'))?.activeOperations['child-call']).toMatchObject({
        callId: 'child-call',
      });
      expect(await store.load('child')).toBeNull();
      await cleanup();
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
      else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });

  test('reuses successful V2 parent lookups across repeated child operations', async () => {
    const calls: Array<{ sessionID: string }> = [];
    let before: BeforeCallback | undefined;
    const cleanup = await SessionGuardPluginV2(
      v2ContextWithParents(
        { child: 'root' },
        (name, registered) => {
          if (name === 'execute.before') before = registered as BeforeCallback;
        },
        calls
      )
    );

    await expect(
      before!({
        tool: 'unknown',
        sessionID: 'child',
        agent: 'code',
        messageID: 'message-one',
        id: 'call-one',
        input: {},
      })
    ).resolves.toBeUndefined();
    await expect(
      before!({
        tool: 'unknown',
        sessionID: 'child',
        agent: 'code',
        messageID: 'message-two',
        id: 'call-two',
        input: {},
      })
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ sessionID: 'child' }, { sessionID: 'root' }]);
    await cleanup();
  });

  test('retries a rejected V2 parent lookup without mutating another workflow session', async () => {
    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const storeDirectory = await mkdtemp(join(tmpdir(), 'v2-parent-rejection-store-'));
    process.env.SESSION_GUARD_STORE_DIR = storeDirectory;

    try {
      const store = new WorkflowStore(storeDirectory);
      await store.save(executionSession('unrelated-root'));
      let attempts = 0;
      let before: BeforeCallback | undefined;
      const context = v2Context((name, registered) => {
        if (name === 'execute.before') before = registered as BeforeCallback;
      }) as unknown as {
        session: { get(input: { sessionID: string }): Promise<{ parentID?: string }> };
      };
      context.session = {
        get: async () => {
          attempts += 1;
          throw new Error('lookup rejected');
        },
      };
      const cleanup = await SessionGuardPluginV2(context as unknown as Context);

      for (const id of ['first-call', 'second-call']) {
        await before!({
          tool: 'unknown',
          sessionID: 'failing-child',
          agent: 'code',
          messageID: `message-${id}`,
          id,
          input: {},
        });
      }

      expect(attempts).toBe(2);
      expect((await store.load('unrelated-root'))?.activeOperations).toEqual({});
      expect(await store.load('failing-child')).toBeNull();
      await cleanup();
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });

  test('records and resolves V2 consent through the verified context capability', async () => {
    const previousStore = process.env.SESSION_GUARD_STORE_DIR;
    const storeDirectory = await mkdtemp(join(tmpdir(), 'v2-consent-store-'));
    process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
    const manifest: ConsentManifest = {
      schema: 'harness.consent.evidence/v1',
      revision: 0,
      summary: 'Approve the V2 plan',
      files: ['plan.md'],
    };
    const evidence = evidenceOf(manifest);
    const request = `<consent-request schema="harness.consent/v1" revision="0" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    try {
      await writeFile(join(v2FixtureProject, 'plan.md'), '# V2 plan\n');
      const store = new WorkflowStore(storeDirectory);
      const session = createSession('v2-consent', 'base', 'session-guard', 'planning');
      await store.save(session);
      let before: BeforeCallback | undefined;
      let after: AfterCallback | undefined;
      const context = v2Context((name, callback) => {
        if (name === 'execute.before') before = callback as BeforeCallback;
        else after = callback as AfterCallback;
      }) as unknown as { session: { context: () => Promise<unknown[]> } };
      context.session = {
        context: async () => [{ type: 'user', content: [{ type: 'text', text: request }] }],
      };
      const cleanup = await SessionGuardPluginV2(context as unknown as Context);

      await before!({
        tool: 'question',
        sessionID: 'v2-consent',
        agent: 'orchestrator',
        messageID: 'message-consent',
        id: 'call-consent',
        input: { questions: [{ question: request }] },
      });
      expect((await store.load('v2-consent'))?.approvals).toContainEqual(
        expect.objectContaining({ type: 'plan', callId: 'call-consent', status: 'pending' })
      );

      await after!({
        tool: 'question',
        sessionID: 'v2-consent',
        agent: 'orchestrator',
        messageID: 'message-consent',
        id: 'call-consent',
        input: { questions: [{ question: request }] },
        status: 'completed',
        result: { output: request, metadata: { answers: ['grant'] } },
      });
      const resolved = await store.load('v2-consent');
      expect(resolved?.approvals).toContainEqual(
        expect.objectContaining({ type: 'plan', callId: 'call-consent', status: 'granted' })
      );
      expect(resolved?.currentStage).toBe('planning');
      expect(resolved?.approvals.some((approval) => approval.status === 'pending')).toBe(false);
      expect(resolved?.approvals[0]?.evidence).toBe(
        calculateDocumentSetEvidence([['plan.md', '# V2 plan\n']])
      );
      await cleanup();
    } finally {
      if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previousStore;
      await rm(join(v2FixtureProject, 'plan.md'), { force: true });
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });
});
