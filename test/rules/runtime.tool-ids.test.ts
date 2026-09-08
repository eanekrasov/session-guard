import { describe, it, expect } from 'bun:test';
import { OpenCodeRulesRuntime } from '../../src/rules/runtime.js';
import { SessionStore } from '../../src/rules/session-store.js';
import * as runtimeModule from '../../src/rules/runtime.js';
import * as runtimeContextModule from '../../src/rules/runtime-context.js';
import * as runtimeChatModule from '../../src/rules/runtime-chat.js';
import { hostPayload } from '../support/host-payload.ts';

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
        client: {
          tool: { ids: async () => ({ data: ['bash'] }) },
          mcp: {
            status: async () => ({
              data: { context7: { status: 'connected' } },
            }),
          },
        } as unknown,
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
        client: {
          tool: { ids: async () => ({ data: ['bash'] }) },
          // no mcp property
        } as unknown,
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
});
