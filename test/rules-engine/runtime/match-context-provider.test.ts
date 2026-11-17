import { describe, expect, it, vi } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuleMatchContextProvider } from '../../../src/rules-engine/runtime/match-context-provider.js';
import { createDebugLog } from '../../../src/rules-engine/shared/debug.js';
import { createRuntime } from '../../../src/rules-engine/runtime/create-runtime.js';
import {
  createMockPluginInput,
  createMockRuntimePort,
} from '../../../src/rules-engine/test-fixtures.js';
import { createRuntime as createWorkflowRuntime } from '../../../src/app/runtime.js';

describe('RuleMatchContextProvider', () => {
  it('includes the current workflow stage in rule matching context', async () => {
    const provider = createRuleMatchContextProvider({
      projectDirectory: process.cwd(),
      getCurrentStage: async (sessionID) => (sessionID === 'session-a' ? 'review' : undefined),
      debugLog: createDebugLog(),
    });

    expect((await provider.getMatchContext('session-a', undefined, true)).stage).toBe('review');
    expect((await provider.getMatchContext('session-b', undefined, true)).stage).toBeUndefined();
  });

  it('does not read the stage unless requested and tolerates stage read failures', async () => {
    const getCurrentStage = vi.fn(async () => {
      throw new Error('session file unavailable');
    });
    const debugLog = vi.fn();
    const provider = createRuleMatchContextProvider({
      projectDirectory: process.cwd(),
      getCurrentStage,
      debugLog,
    });

    expect((await provider.getMatchContext('session-a')).stage).toBeUndefined();
    expect(getCurrentStage).not.toHaveBeenCalled();

    expect((await provider.getMatchContext('session-a', undefined, true)).stage).toBeUndefined();
    expect(getCurrentStage).toHaveBeenCalledTimes(1);
    expect(
      debugLog.mock.calls.some(([message]) =>
        String(message).includes('Failed to read workflow stage')
      )
    ).toBe(true);
  });

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
      port: createMockRuntimePort(mock),
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
      port: createMockRuntimePort(mock),
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
      await workflowHooks['tool.execute.after']!(
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
