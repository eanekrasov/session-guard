import { describe, expect, test } from 'bun:test';
import type { OpenCodeRulesRuntime } from '../../src/rules-engine/runtime/orchestrator.js';
import { wireV1Rules } from '../../src/rules-engine/runtime/v1-adapter.js';

describe('V1 rules adapter', () => {
  test('bridges durable prompt and transient context injection, then restores hooks', async () => {
    const originalChatMessage = async () => {};
    const originalMessagesTransform = async () => {};
    const hooks: Record<string, unknown> = {
      'chat.message': originalChatMessage,
      'experimental.chat.messages.transform': originalMessagesTransform,
    };
    let cleanupCalled = false;
    let forwardedSessionID: unknown;
    const runtime: Pick<OpenCodeRulesRuntime, 'wire'> = {
      wire: async (context) => {
        const session = context.session;
        if (!session?.hook || !session.synthetic) throw new Error('Session hooks unavailable');
        const synthetic = session.synthetic;
        await session.hook('prompt', async () => {
          await synthetic({
            sessionID: 'ses_v1',
            id: 'msg_durable',
            text: 'Durable rule',
          });
        });
        await session.hook('context', async (input) => {
          forwardedSessionID = input.sessionID;
          if (!Array.isArray(input.messages)) throw new Error('Context messages unavailable');
          input.messages.push({
            id: 'msg_transient',
            role: 'user',
            content: [{ type: 'text', text: 'Transient rule' }],
          });
        });
        return async () => {
          cleanupCalled = true;
        };
      },
    };

    const cleanup = await wireV1Rules(runtime, hooks);
    const chatOutput: { message: { id: string }; parts: Array<Record<string, unknown>> } = {
      message: { id: 'msg_user' },
      parts: [{ id: 'part_user', type: 'text', text: 'Apply the rules' }],
    };
    await (hooks['chat.message'] as (input: unknown, output: unknown) => Promise<void>)(
      { sessionID: 'ses_v1', messageID: 'msg_user' },
      chatOutput
    );
    expect(chatOutput.parts).toContainEqual({
      id: 'msg_durable',
      sessionID: 'ses_v1',
      messageID: 'msg_user',
      type: 'text',
      text: 'Durable rule',
      synthetic: true,
    });

    const contextOutput: { messages: Array<Record<string, unknown>> } = {
      messages: [
        {
          info: {
            id: 'msg_user',
            sessionID: 'ses_v1',
            role: 'user',
            time: { created: 1 },
            agent: 'code',
            model: { providerID: 'test', modelID: 'model' },
          },
          parts: [{ id: 'part_user', type: 'text', text: 'Apply the rules' }],
        },
      ],
    };
    await (
      hooks['experimental.chat.messages.transform'] as (
        input: unknown,
        output: { messages: Array<Record<string, unknown>> }
      ) => Promise<void>
    )({ sessionID: 'ses_v1' }, contextOutput);
    expect(forwardedSessionID).toBe('ses_v1');
    expect(contextOutput.messages.at(-1)).toEqual({
      info: {
        id: 'msg_transient',
        sessionID: 'ses_v1',
        role: 'user',
        time: { created: 1 },
        agent: 'code',
        model: { providerID: 'test', modelID: 'model' },
      },
      parts: [
        {
          id: 'msg_transient_part_0',
          sessionID: 'ses_v1',
          messageID: 'msg_transient',
          type: 'text',
          text: 'Transient rule',
          synthetic: true,
        },
      ],
    });

    await cleanup();
    expect(cleanupCalled).toBe(true);
    expect(hooks['chat.message']).toBe(originalChatMessage);
    expect(hooks['experimental.chat.messages.transform']).toBe(originalMessagesTransform);
  });
});
