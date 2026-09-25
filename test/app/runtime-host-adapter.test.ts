import { describe, expect, test } from 'bun:test';
import {
  createV1RuntimeHostAdapter,
  createV2RuntimeHostAdapter,
} from '../../src/app/runtime-host-adapter.ts';

describe('runtime host adapters', () => {
  test('V1 keeps optional SDK capabilities at the adapter boundary', async () => {
    const calls: unknown[] = [];
    const adapter = createV1RuntimeHostAdapter({
      directory: '/project',
      client: {
        session: {
          get: async (input: unknown) => {
            calls.push(['get', input]);
            return { data: { id: 'session-1' } };
          },
          list: async (input: unknown) => {
            calls.push(['list', input]);
            return { data: [{ id: 'session-1' }] };
          },
          messages: async (input: unknown) => {
            calls.push(['messages', input]);
            return { data: [{ info: { id: 'message-1' }, parts: [] }] };
          },
          prompt: async (input: unknown) => {
            calls.push(['prompt', input]);
            return { data: { id: 'message-2' } };
          },
        },
        tool: { ids: async () => ({ data: ['bash', 'read'] }) },
      } as never,
    });

    expect(adapter.session).toBeDefined();
    await adapter.session.get?.({ path: { id: 'session-1' }, query: { directory: '/project' } });
    await adapter.session.list?.({ query: { directory: '/project' } });
    await adapter.session.messages?.({
      path: { id: 'session-1' },
      query: { directory: '/project' },
    });
    await adapter.session.prompt?.({
      path: { id: 'session-1' },
      query: { directory: '/project' },
      body: { parts: [] },
    });
    expect(calls).toEqual([
      ['get', { path: { id: 'session-1' }, query: { directory: '/project' } }],
      ['list', { query: { directory: '/project' } }],
      ['messages', { path: { id: 'session-1' }, query: { directory: '/project' } }],
      [
        'prompt',
        { path: { id: 'session-1' }, query: { directory: '/project' }, body: { parts: [] } },
      ],
    ]);
    await expect(adapter.tools.list?.()).resolves.toEqual([{ id: 'bash' }, { id: 'read' }]);
  });

  test('V1 preserves connected MCP mapping and directory-scoped tool requests', async () => {
    let toolQuery: unknown;
    let mcpQuery: unknown;
    const adapter = createV1RuntimeHostAdapter({
      directory: '/project',
      client: {
        tool: { ids: async (input: unknown) => ((toolQuery = input), { data: ['bash'] }) },
        mcp: {
          status: async (input: unknown) => {
            mcpQuery = input;
            return { data: { docs: { status: 'connected' }, offline: { status: 'disconnected' } } };
          },
        },
      } as never,
    });

    await expect(adapter.tools.list?.()).resolves.toEqual([{ id: 'bash' }, { id: 'mcp_docs' }]);
    expect(toolQuery).toEqual({ query: { directory: '/project' } });
    expect(mcpQuery).toEqual({ query: { directory: '/project' } });
  });

  test('V2 exposes confirmed parent and tool discovery only', async () => {
    const adapter = createV2RuntimeHostAdapter({
      directory: '/project',
      context: {
        location: { project: { directory: '/project' } },
        session: { get: async () => ({ parentID: 'parent-1' }) },
        tool: { list: async () => [{ id: 'bash' }, { id: 'workflow-create' }] },
      } as never,
    });

    await expect(adapter.resolveParent?.('child-1')).resolves.toBe('parent-1');
    await expect(adapter.tools.list?.()).resolves.toEqual([
      { id: 'bash' },
      { id: 'workflow-create' },
    ]);
    expect(adapter.session).toEqual({});
  });

  test('V2 makes unsupported optional capabilities explicit and harmless', async () => {
    const adapter = createV2RuntimeHostAdapter({
      directory: '/project',
      context: {
        location: { project: { directory: '/project' } },
        session: {},
        tool: { list: async () => [] },
      } as never,
    });

    expect(adapter.session.get).toBeUndefined();
    expect(adapter.session.list).toBeUndefined();
    expect(adapter.session.messages).toBeUndefined();
    expect(adapter.session.prompt).toBeUndefined();
    await expect(adapter.tools.list?.()).resolves.toEqual([]);
    expect(() => adapter.report('unsupported')).not.toThrow();
    await expect(adapter.log('info', 'unsupported')).resolves.toBeUndefined();
  });
});
