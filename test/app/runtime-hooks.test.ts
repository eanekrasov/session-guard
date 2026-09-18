import { describe, expect, test, vi } from 'vitest';
import { createRuntimeHooks } from '../../src/app/runtime-hooks.ts';

describe('runtime hooks adapter', () => {
  test('exposes the supported hook keys and delegates host callbacks', async () => {
    const config = vi.fn(async () => {});
    const chatMessage = vi.fn(async () => {});
    const before = vi.fn(async () => {});
    const after = vi.fn(async () => {});
    const event = vi.fn(async () => {});
    const systemTransform = vi.fn(async () => {});
    const compacting = vi.fn(async () => {});
    const messagesTransform = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});

    const hooks = createRuntimeHooks({
      config,
      chatMessage,
      before,
      after,
      event,
      systemTransform,
      compacting,
      messagesTransform,
      dispose,
      tools: {},
    });

    expect(Object.keys(hooks).sort()).toEqual(
      [
        'chat.message',
        'config',
        'dispose',
        'event',
        'experimental.chat.messages.transform',
        'experimental.chat.system.transform',
        'experimental.session.compacting',
        'tool.execute.after',
        'tool.execute.before',
        'tool',
      ].sort()
    );

    const hookInput = { sessionID: 'session-1', tool: 'write', callID: 'call-1' };
    const hookOutput = { args: { filePath: 'README.md' } };
    await hooks['tool.execute.before']!(hookInput, hookOutput);
    await hooks['tool.execute.after']!(
      { ...hookInput, args: hookOutput.args },
      { title: 'write', output: 'ok', metadata: {} }
    );

    expect(before).toHaveBeenCalledWith(hookInput, hookOutput);
    expect(after).toHaveBeenCalledWith(
      { ...hookInput, args: hookOutput.args },
      { title: 'write', output: 'ok', metadata: {} }
    );
  });

  test('propagates adapter callback failures without swallowing them', async () => {
    const failure = new Error('blocked');
    const before = vi.fn(async () => {
      throw failure;
    });

    const hooks = createRuntimeHooks({
      config: vi.fn(async () => {}),
      chatMessage: vi.fn(async () => {}),
      before,
      after: vi.fn(async () => {}),
      event: vi.fn(async () => {}),
      systemTransform: vi.fn(async () => {}),
      compacting: vi.fn(async () => {}),
      messagesTransform: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      tools: {},
    });

    await expect(
      hooks['tool.execute.before']!(
        { sessionID: 'session-1', tool: 'write', callID: 'call-1' },
        { args: {} }
      )
    ).rejects.toBe(failure);
  });
});
