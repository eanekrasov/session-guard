import { describe, expect, test } from 'bun:test';
import type { Context } from '@opencode/plugin/promise/plugin';
import { Tool } from '@opencode/schema/tool';
import {
  V2_CAPABILITIES,
  v2ParentResolver,
  v2ProjectDirectory,
  v2ToolAfterEvent,
  v2ToolBeforeEvent,
  v2WorktreeDirectory,
  type V2ToolAfterEvent,
  type V2ToolBeforeEvent,
} from '../../src/app/v2-plugin-contract.ts';

type V2SessionGetInput = Parameters<Context['session']['get']>[0];

describe('V2 plugin contract', () => {
  test('derives project and worktree identity from the V2 location contract', () => {
    const context = {
      location: {
        directory: '/workspace/worktree',
        project: {
          directory: '/workspace/project',
        },
      },
    } as Context;

    expect(v2ProjectDirectory(context)).toBe('/workspace/project');
    expect(v2WorktreeDirectory(context)).toBe('/workspace/worktree');
  });

  test('models stable tool identity and the completed/error after union', () => {
    const before: V2ToolBeforeEvent = {
      tool: 'edit',
      sessionID: 'session-1',
      agent: 'agent-1',
      messageID: 'message-1',
      callID: 'call-1',
      input: { filePath: 'src/index.ts' },
    };
    const completed: V2ToolAfterEvent = {
      ...before,
      status: 'completed',
      result: { output: 'ok' },
    };
    const failed: V2ToolAfterEvent = {
      ...before,
      status: 'error',
      error: new Tool.Error({ message: 'failed' }),
    };

    expect(completed.status).toBe('completed');
    expect(failed.status).toBe('error');
    expect(completed.callID).toBe(failed.callID);
  });

  test('preserves required V2 tool identity', () => {
    expect(
      v2ToolBeforeEvent({
        tool: 'edit',
        sessionID: 'session-1',
        agent: 'agent-1',
        messageID: 'message-1',
        id: 'call-1',
        input: { filePath: 'src/index.ts' },
      })
    ).toMatchObject({ agent: 'agent-1', messageID: 'message-1', callID: 'call-1' });
  });

  test('extracts only text output for completed events and preserves errors as errors', () => {
    const completed = v2ToolAfterEvent({
      tool: 'edit',
      sessionID: 'session-1',
      agent: 'agent-1',
      messageID: 'message-1',
      id: 'call-1',
      input: { filePath: 'src/index.ts' },
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'safe output' },
          { type: 'file', uri: 'file:///secret', mime: 'text/plain' },
        ],
      },
    });
    const failed = v2ToolAfterEvent({
      tool: 'edit',
      sessionID: 'session-1',
      agent: 'agent-1',
      messageID: 'message-1',
      id: 'call-1',
      input: {},
      status: 'error',
      error: new Tool.Error({ message: 'failed' }),
    });

    expect(completed).toMatchObject({ status: 'completed', result: { output: 'safe output' } });
    expect(failed).toMatchObject({ status: 'error', error: { message: 'failed' } });
  });

  test('makes unsupported and deferred V2 capabilities explicit', () => {
    expect(V2_CAPABILITIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Tool before policy', status: 'supported' }),
        expect.objectContaining({ name: 'Tool after lifecycle', status: 'supported' }),
        expect.objectContaining({ name: 'Chat message processing', status: 'deferred' }),
        expect.objectContaining({ name: 'Runtime disposal', status: 'supported' }),
      ])
    );
    expect(V2_CAPABILITIES.every((capability) => capability.reason.length > 0)).toBe(true);
  });

  test('uses typed session inputs and projects only non-empty V2 parent IDs', async () => {
    const calls: Array<{ sessionID: string }> = [];
    const resolveParent = v2ParentResolver({
      get: async ({ sessionID }: V2SessionGetInput) => {
        calls.push({ sessionID });
        return sessionID === 'child' ? ({ parentID: 'root' } as never) : ({} as never);
      },
    } as never);

    await expect(resolveParent('child')).resolves.toBe('root');
    await expect(resolveParent('root')).resolves.toBeNull();
    expect(calls).toEqual([{ sessionID: 'child' }, { sessionID: 'root' }]);
  });
});
