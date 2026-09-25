import { describe, it, expect } from 'bun:test';
import { OpenCodeRulesRuntime } from '../../src/rules/runtime.js';
import { SessionStore } from '../../src/rules/session-store.js';
import * as runtimeModule from '../../src/rules/runtime.js';
import * as runtimeContextModule from '../../src/rules/runtime-context.js';
import * as runtimeChatModule from '../../src/rules/runtime-chat.js';
import { hostPayload } from '../support/host-payload.ts';
import { createV1RuntimeHostAdapter } from '../../src/app/runtime-host-adapter.ts';
import { createV2RuntimeHostAdapter } from '../../src/app/runtime-host-adapter.ts';

describe('runtime module runtime exports', () => {
  it('exports only OpenCodeRulesRuntime class at runtime', () => {
    const exportedKeys = Object.keys(runtimeModule).sort();
    expect(exportedKeys).toEqual(['OpenCodeRulesRuntime']);
  });
});

describe('runtime module boundaries', () => {
  it('exports buildRuleMatchContext from runtime-context module', () => {
    expect(runtimeContextModule.buildRuleMatchContext).toBeDefined();
    expect(typeof runtimeContextModule.buildRuleMatchContext).toBe('function');
  });

  it('exports detectCiEnvironment from runtime-context module', () => {
    expect(runtimeContextModule.detectCiEnvironment).toBeDefined();
    expect(typeof runtimeContextModule.detectCiEnvironment).toBe('function');
  });

  it('exports updateSessionFromChatMessage from runtime-chat module', () => {
    expect(runtimeChatModule.updateSessionFromChatMessage).toBeDefined();
    expect(typeof runtimeChatModule.updateSessionFromChatMessage).toBe('function');
  });
});

describe('OpenCodeRulesRuntime.queryAvailableToolIDs', () => {
  it('augments tool ids with connected mcp capability ids', async () => {
    const runtime = new OpenCodeRulesRuntime(
      hostPayload({
        host: createV1RuntimeHostAdapter({
          client: hostPayload({
            tool: { ids: async () => ({ data: ['bash'] }) },
            mcp: {
              status: async () => ({
                data: { context7: { status: 'connected' } },
              }),
            },
          }),
          directory: '/tmp',
        }),
        directory: '/tmp',
        projectDirectory: '/tmp',
        ruleFiles: [],
        sessionStore: new SessionStore({ max: 10 }),
        debugLog: () => {},
      })
    );

    const ids: string[] = await (
      runtime as unknown as { queryAvailableToolIDs: () => Promise<string[]> }
    ).queryAvailableToolIDs();
    expect(ids).toContain('bash');
    expect(ids).toContain('mcp_context7');
  });

  it('handles missing mcp.status gracefully', async () => {
    const runtime = new OpenCodeRulesRuntime(
      hostPayload({
        host: createV1RuntimeHostAdapter({
          client: hostPayload({
            tool: { ids: async () => ({ data: ['bash'] }) },
            // no mcp property
          }),
          directory: '/tmp',
        }),
        directory: '/tmp',
        projectDirectory: '/tmp',
        ruleFiles: [],
        sessionStore: new SessionStore({ max: 10 }),
        debugLog: () => {},
      })
    );

    const ids: string[] = await (
      runtime as unknown as { queryAvailableToolIDs: () => Promise<string[]> }
    ).queryAvailableToolIDs();
    expect(ids).toContain('bash');
    // Should not throw, just not include mcp_ ids
  });

  it('uses V2 tool ids while treating absent history as empty history', async () => {
    const runtime = new OpenCodeRulesRuntime(
      hostPayload({
        host: createV2RuntimeHostAdapter({
          directory: '/tmp',
          context: {
            location: { project: { directory: '/tmp' } },
            session: {},
            tool: { list: async () => [{ id: 'bash' }, { id: 'workflow-create' }] },
          } as never,
        }),
        directory: '/tmp',
        projectDirectory: '/tmp',
        ruleFiles: [],
        sessionStore: new SessionStore({ max: 10 }),
        debugLog: () => {},
      })
    );

    const ids: string[] = await (
      runtime as unknown as { queryAvailableToolIDs: () => Promise<string[]> }
    ).queryAvailableToolIDs();
    expect(ids).toEqual(['bash', 'workflow-create']);
    await expect(
      (
        runtime as unknown as { readClientHistory: (sessionID: string) => Promise<unknown> }
      ).readClientHistory('session-1')
    ).resolves.toEqual({ ok: true, messages: [] });
  });
});
