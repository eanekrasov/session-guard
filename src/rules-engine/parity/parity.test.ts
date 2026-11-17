/**
 * Parity tests: identical rule scenarios through the V1 and V2 delivery paths
 * must produce identical durable/transient deliveries (D6). Each scenario also
 * carries a golden assertion on the V2 (reference) output so a common bug in
 * both paths cannot hide behind path-to-path equality.
 *
 * Scenario set (tasks 5.2): durable prompt delivery, transient context
 * injection, tool-after observation (fileContains + globs), stage context,
 * broken rule file, empty rule set.
 */
import { describe, expect, test } from 'bun:test';
import { expectGolden, runBothPaths, userMessage } from './parity-helpers.js';

describe('V1/V2 rules delivery parity', () => {
  test('durable prompt delivery is identical on both paths', async () => {
    const result = await runBothPaths({
      name: 'durable_prompt',
      rules: [{ name: 'always.mdc', content: '# Always Apply\n\nUse plain text always.' }],
      run: async (events, sessionID) => {
        await events.prompt({
          sessionID,
          messageID: 'msg_user',
          text: 'Review this',
        });
      },
    });

    expectGolden(result.v2, { durable: ['Use plain text always.'] });
    expect(result.v1.durableText).toEqual(result.v2.durableText);
    expect(result.v1.durableMetadata).toEqual(result.v2.durableMetadata);
    expect(result.v1.transientText).toEqual(result.v2.transientText);
  });

  test('durable text contains the rule body on both paths', async () => {
    const result = await runBothPaths({
      name: 'durable_body',
      rules: [{ name: 'always.mdc', content: '# Always Apply\n\nObserve body text.' }],
      run: async (events, sessionID) => {
        await events.prompt({ sessionID, messageID: 'msg_user', text: 'Continue' });
      },
    });
    expect(result.v2.durableText[0]).toContain('Observe body text.');
    expect(result.v1.durableText[0]).toContain('Observe body text.');
  });

  test('transient context injection appends the rule on both paths', async () => {
    const result = await runBothPaths({
      name: 'transient_cxt',
      rules: [{ name: 'live.mdc', content: '---\nagent: [code]\n---\n\nLive guidance.' }],
      run: async (events, sessionID) => {
        await events.context({
          sessionID,
          agent: 'code',
          messages: [userMessage('Help me')],
        });
      },
    });
    expectGolden(result.v2, { transient: ['Live guidance.'] });
    expect(result.v1.transientText).toEqual(result.v2.transientText);
  });

  test('tool-after observation admits fileContains durable rule on both paths', async () => {
    const result = await runBothPaths({
      name: 'tool_filecontains',
      rules: [
        {
          name: 'found.mdc',
          content: '---\nfileContains: "session:prt"\n---\n\nObservation rule.',
        },
      ],
      run: async (events, sessionID) => {
        await events.toolAfter({
          tool: 'write',
          sessionID,
          id: 'call_read',
          input: { filePath: 'pack.json', content: 'lsp:found\nsession:prt' },
          result: { output: 'Wrote file successfully.' },
        });
        // V2 admits the observation immediately; V1 flushes it on the next
        // chat.message turn. The full lifecycle converges on one durable text.
        await events.prompt({ sessionID, messageID: 'msg_next', text: 'Continue' });
      },
    });
    expectGolden(result.v2, { durable: ['Observation rule.'] });
    expect(result.v1.durableText).toEqual(result.v2.durableText);
    expect(result.v1.durableMetadata).toEqual(result.v2.durableMetadata);
  });

  test('tool-after globs observation admits glob durable rule on both paths', async () => {
    const result = await runBothPaths({
      name: 'tool_globs',
      rules: [
        {
          name: 'globbed.mdc',
          content: '---\nglobs:\n  - "**/src/components/**"\n---\n\nGlob rule.',
        },
      ],
      run: async (events, sessionID) => {
        await events.toolAfter({
          tool: 'write',
          sessionID,
          id: 'call_glob',
          input: { filePath: 'src/components/Button.tsx', content: 'write body' },
          result: { output: 'Wrote file successfully.' },
        });
        await events.prompt({ sessionID, messageID: 'msg_next', text: 'Continue' });
      },
    });
    expectGolden(result.v2, { durable: ['Glob rule.'] });
    expect(result.v1.durableText).toEqual(result.v2.durableText);
    expect(result.v1.transientText).toEqual(result.v2.transientText);
  });

  test('stage context flows into both paths', async () => {
    const result = await runBothPaths({
      name: 'stage',
      rules: [{ name: 'stage.mdc', content: '---\nstage:\n  - review\n---\n\nReview guidance.' }],
      getCurrentStage: async (sessionID) => (sessionID === 'ses_stage' ? 'review' : undefined),
      run: async (events, sessionID) => {
        await events.context({
          sessionID,
          messages: [userMessage('Review this')],
        });
      },
    });
    expectGolden(result.v2, { transient: ['Review guidance.'] });
    expect(result.v1.transientText).toEqual(result.v2.transientText);
  });

  test('broken rule file is ignored on both paths without crashing', async () => {
    const result = await runBothPaths({
      name: 'broken_rule',
      rules: [
        { name: 'bad.mdc', content: '---\nnot: [valid\n---\n\nBroken.' },
        { name: 'good.mdc', content: '# Good\n\nDelivery still works.' },
      ],
      run: async (events, sessionID) => {
        await events.prompt({ sessionID, messageID: 'msg_user', text: 'Continue' });
      },
    });
    expectGolden(result.v2, { durable: ['Delivery still works.'] });
    expect(result.v1.durableText).toEqual(result.v2.durableText);
  });

  test('empty rule set delivers nothing on both paths', async () => {
    const result = await runBothPaths({
      name: 'empty_rules',
      rules: [],
      run: async (events, sessionID) => {
        await events.prompt({ sessionID, messageID: 'msg_user', text: 'Continue' });
      },
    });
    expect(result.v2.durableText).toHaveLength(0);
    expect(result.v1.durableText).toEqual(result.v2.durableText);
    expect(result.v1.transientText).toEqual(result.v2.transientText);
  });

  test('durable metadata carries ruleKeys on both paths (golden reference)', async () => {
    const result = await runBothPaths({
      name: 'state_ref',
      rules: [{ name: 'always.mdc', content: '# Always\n\nRef rule.' }],
      run: async (events, sessionID) => {
        await events.prompt({ sessionID, messageID: 'msg_user', text: 'Continue' });
      },
    });
    expect(result.v2.durableText).toHaveLength(1);
    expect(result.v2.durableMetadata[0]?.ruleKeys).toBeDefined();
    expect(result.v1.durableMetadata).toEqual(result.v2.durableMetadata);
  });
});
