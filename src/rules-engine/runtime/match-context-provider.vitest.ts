import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuleMatchContextProvider } from './match-context-provider.js';
import { createDebugLog } from '../shared/debug.js';
import { createRuntime } from './create-runtime.js';
import { createMockPluginInput } from '../test-fixtures.js';
import { createRuntime as createWorkflowRuntime } from '../../app/runtime.js';

describe('RuleMatchContextProvider', () => {
  it('keeps available tools isolated per session and clears them for an empty tool table', async () => {
    const provider = createRuleMatchContextProvider({
      projectDirectory: process.cwd(),
      debugLog: createDebugLog(),
    });
    provider.setAvailableToolIDs('session-a', ['bash']);
    provider.setAvailableToolIDs('session-b', []);

    expect(provider.getAvailableToolIDs('session-a')).toEqual(['bash']);
    expect(provider.getAvailableToolIDs('session-b')).toEqual([]);
    expect((await provider.getMatchContext('session-b')).availableToolIDs).toBeUndefined();
  });

  it('shares turn state and observations by source session', async () => {
    const provider = createRuleMatchContextProvider({
      projectDirectory: process.cwd(),
      debugLog: createDebugLog(),
    });
    const mock = createMockPluginInput({ testDir: process.cwd() });
    const rulesRuntime = await createRuntime({
      client: mock.context,
      directory: process.cwd(),
      projectDirectory: process.cwd(),
      ruleFiles: [],
      matchContextProvider: provider,
    });
    const cleanup = await rulesRuntime.wire(mock.context);
    await mock.hooks.sessionContext[0]?.({
      sessionID: 'child-session',
      agent: 'reviewer',
      model: { id: 'model-id' },
      messages: [],
      tools: { bash: {} },
    });
    await mock.hooks.sessionPrompt[0]?.({
      sessionID: 'child-session',
      prompt: { text: '/review inspect changed files' },
    });
    await mock.hooks.toolAfter[0]?.({
      tool: 'read',
      sessionID: 'child-session',
      input: { filePath: 'src/example.ts' },
      status: 'completed',
      result: { output: 'Read file src/example.ts\n1: unique-content' },
    });

    const context = await provider.getMatchContext('child-session');

    expect(context).toMatchObject({
      userPrompt: '/review inspect changed files',
      command: '/review',
      modelID: 'model-id',
      agentType: 'reviewer',
      availableToolIDs: ['bash'],
    });
    expect(context.fileObservations).toHaveLength(1);
    expect(context.fileObservations?.[0]?.content).toContain('unique-content');
    expect((await provider.getMatchContext('root-session')).fileObservations).toBeUndefined();
    await cleanup();
  });

  it('does not require a workflow session to keep observations or write them twice', async () => {
    const provider = createRuleMatchContextProvider({
      projectDirectory: process.cwd(),
      debugLog: createDebugLog(),
    });
    const mock = createMockPluginInput({ testDir: process.cwd() });
    const rulesRuntime = await createRuntime({
      client: mock.context,
      directory: process.cwd(),
      projectDirectory: process.cwd(),
      ruleFiles: [],
      matchContextProvider: provider,
    });
    const cleanup = await rulesRuntime.wire(mock.context);
    const event = {
      tool: 'read',
      sessionID: 'session-without-workflow',
      input: { filePath: 'src/example.ts' },
      status: 'completed',
      result: { output: 'Read file src/example.ts\n1: unique-content' },
    };
    await mock.hooks.toolAfter[0]?.(event);

    const tempDirectory = mkdtempSync(join(tmpdir(), 'session-guard-provider-'));
    try {
      const workflowHooks = createWorkflowRuntime(
        {
          directory: process.cwd(),
          host: {
            directory: process.cwd(),
            session: {},
            tools: {},
            log: async () => {},
            report: () => {},
          },
          matchContextProvider: provider,
        },
        { storeDir: join(tempDirectory, 'store'), profilesDir: join(tempDirectory, 'profiles') }
      );
      const after = workflowHooks['tool.execute.after'] as unknown as (
        input: { tool: string; sessionID: string; callID: string; args: unknown },
        output: { title: string; output: string; metadata: unknown }
      ) => Promise<void>;
      await after(
        {
          tool: 'read',
          sessionID: 'session-without-workflow',
          callID: 'call-1',
          args: event.input,
        },
        { title: 'read', output: 'Read file src/example.ts\n1: unique-content', metadata: {} }
      );

      expect(
        (await provider.getMatchContext('session-without-workflow')).fileObservations
      ).toHaveLength(1);
      await workflowHooks.dispose?.();
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
      await cleanup();
    }
  });
});
