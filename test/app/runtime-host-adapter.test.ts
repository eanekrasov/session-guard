import { describe, expect, test } from 'bun:test';
import {
  createV1RuntimeHostAdapter,
  createV2RuntimeHostAdapter,
} from '../../src/app/runtime-host-adapter.ts';

describe('runtime host adapters', () => {
  test('V1 keeps optional SDK capabilities at the adapter boundary', async () => {
    const adapter = createV1RuntimeHostAdapter({
      directory: '/project',
      client: {
        tool: { ids: async () => ({ data: ['bash', 'read'] }) },
      } as never,
    });

    expect(adapter.session).toBeUndefined();
    await expect(adapter.tools.list?.()).resolves.toEqual([{ id: 'bash' }, { id: 'read' }]);
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
});
