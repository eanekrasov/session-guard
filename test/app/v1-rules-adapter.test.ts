import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OpenCodeRulesRuntime } from '../../src/rules-engine/runtime/orchestrator.js';
import { createRuntime } from '../../src/rules-engine/runtime/create-runtime.js';
import { wireV1Rules } from '../../src/rules-engine/runtime/v1-adapter.js';
import {
  createMockPluginInput,
  createMockRuntimePort,
} from '../../src/rules-engine/test-fixtures.js';

describe('V1 rules adapter', () => {
  test('provides the workflow stage to the V1 rules match context', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'session-guard-v1-stage-'));
    try {
      const rulePath = path.join(testDir, 'stage-rule.md');
      writeFileSync(rulePath, '---\nstage:\n  - review\n---\n\nReview-stage guidance.');
      const mock = createMockPluginInput({ testDir });
      const runtime = await createRuntime({
        port: createMockRuntimePort(mock),
        directory: testDir,
        projectDirectory: testDir,
        ruleFiles: [{ filePath: rulePath, relativePath: 'stage-rule.md' }],
        getCurrentStage: async (sessionID) => (sessionID === 'ses_v1' ? 'review' : undefined),
      });
      const hooks: Record<string, unknown> = {
        'experimental.chat.messages.transform': async () => {},
      };
      const cleanup = await wireV1Rules(runtime, hooks);
      const transform = hooks['experimental.chat.messages.transform'] as (
        input: { sessionID: string },
        output: { messages: Array<Record<string, unknown>> }
      ) => Promise<void>;

      const output = {
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
            parts: [{ id: 'part_user', type: 'text', text: 'Review this' }],
          },
        ],
      };
      await transform({ sessionID: 'ses_v1' }, output);

      expect(output.messages.at(-1)?.parts?.[0]).toMatchObject({
        text: expect.stringContaining('Review-stage guidance.'),
        synthetic: true,
      });
      await cleanup();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

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

  test('prose mention of a path does not trigger a glob rule (compat change)', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'session-guard-v1-prose-'));
    try {
      const rulePath = path.join(testDir, 'prose-rule.mdc');
      writeFileSync(
        rulePath,
        '---\nglobs:\n  - "src/components/Button.tsx"\n---\n\nProse-only guidance.'
      );
      const mock = createMockPluginInput({ testDir });
      const runtime = await createRuntime({
        port: createMockRuntimePort(mock),
        directory: testDir,
        projectDirectory: testDir,
        ruleFiles: [{ filePath: rulePath, relativePath: 'prose-rule.mdc' }],
      });
      const hooks: Record<string, unknown> = {
        'experimental.chat.messages.transform': async () => {},
        'chat.message': async () => {},
      };
      const cleanup = await wireV1Rules(runtime, hooks);
      const transform = hooks['experimental.chat.messages.transform'] as (
        input: { sessionID: string },
        output: { messages: Array<Record<string, unknown>> }
      ) => Promise<void>;

      const output = {
        messages: [
          {
            info: {
              id: 'msg_user',
              sessionID: 'ses_prose',
              role: 'user',
              time: { created: 1 },
              agent: 'code',
              model: { providerID: 'test', modelID: 'model' },
            },
            parts: [{ id: 'part_user', type: 'text', text: 'look at src/components/Button.tsx' }],
          },
        ],
      };
      await transform({ sessionID: 'ses_prose' }, output);

      // Paths named in prose must not be treated as tool observations:
      // glob rules fire on tool reads/writes, not on plain text.
      expect(output.messages).toHaveLength(1);
      await cleanup();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
