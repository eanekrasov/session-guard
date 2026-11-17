import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeContext } from '../../src/app/runtime.ts';
import { createRuleMatchContextProvider } from '../../src/rules-engine/runtime/match-context-provider.ts';
import { createDebugLog } from '../../src/rules-engine/shared/debug.ts';
import {
  createMockPluginInput,
  createMockRuntimePort,
} from '../../src/rules-engine/test-fixtures.ts';
import { createRuntime as createRulesRuntime } from '../../src/rules-engine/runtime/create-runtime.ts';
import { WorkflowStore } from '../../src/session/session-store.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture(): { root: string; profilesDir: string; storeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'session-guard-auto-start-'));
  temporaryDirectories.push(root);
  const profilesDir = join(root, 'profiles');
  const storeDir = join(root, 'store');
  return { root, profilesDir, storeDir };
}

function addProfile(profilesDir: string, id: string, commands: string[]): void {
  const profileDir = join(profilesDir, id);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({ id, schemas: ['default.yaml'] })
  );
  writeFileSync(
    join(profileDir, 'default.yaml'),
    `autoStartTrigger:\n  commands:\n${commands.map((command) => `    - '${command}'`).join('\n')}\nstages:\n  start: {}\n`
  );
}

function runtime(
  root: string,
  profilesDir: string,
  storeDir: string,
  options: {
    autoStart?: boolean;
    matchContextProvider?: RuntimeContext['matchContextProvider'];
    resolveParent?: RuntimeContext['resolveParent'];
  } = {}
) {
  const context: RuntimeContext = {
    directory: root,
    autoStartEnabled: options.autoStart !== false,
    matchContextProvider: options.matchContextProvider,
    resolveParent: options.resolveParent,
    host: {
      directory: root,
      session: {},
      tools: {},
      log: async () => {},
      report: () => {},
    },
  };
  return createRuntime(context, { profilesDir, storeDir });
}

function addKeywordProfile(profilesDir: string, id: string, keyword = 'review'): void {
  const profileDir = join(profilesDir, id);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({ id, schemas: ['default.yaml'] })
  );
  writeFileSync(
    join(profileDir, 'default.yaml'),
    `autoStartTrigger:\n  keywords: [${keyword}]\nstages:\n  start: {}\n`
  );
}

async function beforeBash(hooks: ReturnType<typeof createRuntime>, command: string): Promise<void> {
  const before = hooks['tool.execute.before'] as (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown }
  ) => Promise<void>;
  await before({ tool: 'bash', sessionID: 'session-1', callID: 'call-1' }, { args: { command } });
}

describe('workflow auto-start', () => {
  it('does not start a workflow from a legacy command trigger', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addProfile(profilesDir, 'check', ['^mise run (check|lint)$']);

    const hooks = runtime(root, profilesDir, storeDir);
    await beforeBash(hooks, 'mise run check');

    expect(await new WorkflowStore(storeDir).load('session-1')).toBeNull();
  });

  it('starts a V2 workflow from the shared prompt context before Bash', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addKeywordProfile(profilesDir, 'review');
    const matchContextProvider = createRuleMatchContextProvider({
      projectDirectory: root,
      debugLog: createDebugLog(),
    });
    matchContextProvider.sessionStore.upsert('session-1', (state) => {
      state.lastUserPrompt = '/review inspect this change';
    });

    await beforeBash(runtime(root, profilesDir, storeDir, { matchContextProvider }), 'npm test');

    expect(await new WorkflowStore(storeDir).load('session-1')).toMatchObject({
      profileId: 'review',
      schemaId: 'default',
    });
  });

  it('starts a workflow from tools captured by the real V2 session context hook', async () => {
    const { root, profilesDir, storeDir } = fixture();
    const profileDir = join(profilesDir, 'bash-tool');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'profile.json'),
      JSON.stringify({ id: 'bash-tool', schemas: ['default.yaml'] })
    );
    writeFileSync(
      join(profileDir, 'default.yaml'),
      'autoStartTrigger:\n  tools: [bash]\n  fileContains: [auto-start-observation]\n  match: all\nstages:\n  start: {}\n'
    );

    const matchContextProvider = createRuleMatchContextProvider({
      projectDirectory: root,
      debugLog: createDebugLog(),
    });
    const mock = createMockPluginInput({ testDir: root });
    const rulesRuntime = await createRulesRuntime({
      port: createMockRuntimePort(mock),
      directory: root,
      projectDirectory: root,
      ruleFiles: [],
      matchContextProvider,
    });
    const cleanup = await rulesRuntime.wire(mock.context);

    try {
      const sessionContext = mock.hooks.sessionContext[0] as (input: {
        sessionID: string;
        messages: unknown[];
        tools: Record<string, unknown>;
      }) => Promise<void>;
      await sessionContext({
        sessionID: 'session-1',
        messages: [],
        tools: { bash: {} },
      });
      await mock.hooks.toolAfter[0]?.({
        tool: 'read',
        sessionID: 'session-1',
        input: { filePath: 'src/example.ts' },
        status: 'completed',
        result: { output: 'Read file src/example.ts\n1: auto-start-observation' },
      });

      await beforeBash(runtime(root, profilesDir, storeDir, { matchContextProvider }), 'npm test');

      expect(await new WorkflowStore(storeDir).load('session-1')).toMatchObject({
        profileId: 'bash-tool',
        schemaId: 'default',
      });
    } finally {
      await cleanup();
    }
  });

  it('does not start a workflow when no condition matches', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addKeywordProfile(profilesDir, 'review');
    const matchContextProvider = createRuleMatchContextProvider({
      projectDirectory: root,
      debugLog: createDebugLog(),
    });
    matchContextProvider.sessionStore.upsert('session-1', (state) => {
      state.lastUserPrompt = 'run the tests';
    });

    await beforeBash(runtime(root, profilesDir, storeDir, { matchContextProvider }), 'npm test');

    expect(await new WorkflowStore(storeDir).load('session-1')).toBeNull();
  });

  it('skips auto-start when disabled', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addKeywordProfile(profilesDir, 'review');
    const matchContextProvider = createRuleMatchContextProvider({
      projectDirectory: root,
      debugLog: createDebugLog(),
    });
    matchContextProvider.sessionStore.upsert('session-1', (state) => {
      state.lastUserPrompt = 'review this change';
    });

    await beforeBash(
      runtime(root, profilesDir, storeDir, { autoStart: false, matchContextProvider }),
      'npm test'
    );

    expect(await new WorkflowStore(storeDir).load('session-1')).toBeNull();
  });

  it('skips auto-start when multiple schemas match', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addKeywordProfile(profilesDir, 'first');
    addKeywordProfile(profilesDir, 'second');
    const matchContextProvider = createRuleMatchContextProvider({
      projectDirectory: root,
      debugLog: createDebugLog(),
    });
    matchContextProvider.sessionStore.upsert('session-1', (state) => {
      state.lastUserPrompt = 'review this change';
    });

    await beforeBash(runtime(root, profilesDir, storeDir, { matchContextProvider }), 'npm test');

    expect(await new WorkflowStore(storeDir).load('session-1')).toBeNull();
  });

  it('matches child context and saves the workflow under its resolved root ID', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addKeywordProfile(profilesDir, 'review');
    const matchContextProvider = createRuleMatchContextProvider({
      projectDirectory: root,
      debugLog: createDebugLog(),
    });
    matchContextProvider.sessionStore.upsert('child-session', (state) => {
      state.lastUserPrompt = 'review this change';
    });

    const hooks = runtime(root, profilesDir, storeDir, {
      matchContextProvider,
      resolveParent: async (sessionID) => (sessionID === 'child-session' ? 'root-session' : null),
    });
    const before = hooks['tool.execute.before'] as (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown }
    ) => Promise<void>;
    await before(
      { tool: 'bash', sessionID: 'child-session', callID: 'call-1' },
      { args: { command: 'npm test' } }
    );

    expect(await new WorkflowStore(storeDir).load('root-session')).toMatchObject({
      profileId: 'review',
      schemaId: 'default',
    });
    expect(await new WorkflowStore(storeDir).load('child-session')).toBeNull();
  });

  it('does not execute new-format auto-start without the V2 provider', async () => {
    const { root, profilesDir, storeDir } = fixture();
    addKeywordProfile(profilesDir, 'review');

    await beforeBash(runtime(root, profilesDir, storeDir), 'npm test');

    expect(await new WorkflowStore(storeDir).load('session-1')).toBeNull();
  });
});
