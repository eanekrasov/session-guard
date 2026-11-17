import { describe, expect, it, vi } from 'bun:test';
import { ToolHookFlow } from '../../../src/rules-engine/runtime/tool-hook-flow.js';
import type { RuleSnapshot } from '../../../src/rules-engine/rules/rule-discovery.js';

describe('ToolHookFlow stage filters', () => {
  it('does not block or queue a stage-scoped hook outside its stage', async () => {
    const queueMatchedHooks = vi.fn();
    const rule: RuleSnapshot = {
      filePath: '/rules/review.mdc',
      relativePath: 'review.mdc',
      name: 'review',
      metadata: {
        stage: ['review'],
        hooks: [{ type: 'PreToolUse', tool: 'bash', match: 'danger', block: true }],
      },
      strippedContent: 'Review-only guidance',
    };
    const flow = new ToolHookFlow({
      debugLog: vi.fn(),
      projectDirectory: process.cwd(),
      ensureSessionRuleSnapshot: async () => [rule],
      buildMatchContext: async () => ({ stage: 'planning' }),
      queueMatchedHooks,
    });

    await expect(
      flow.evaluateAndQueueHooks('PreToolUse', 'session-a', 'bash', { command: 'danger' })
    ).resolves.toBeUndefined();
    expect(queueMatchedHooks).not.toHaveBeenCalled();
  });

  it('still blocks when the current stage matches', async () => {
    const rule: RuleSnapshot = {
      filePath: '/rules/review.mdc',
      relativePath: 'review.mdc',
      name: 'review',
      metadata: {
        stage: ['review'],
        hooks: [{ type: 'PreToolUse', tool: 'bash', match: 'danger', block: true }],
      },
      strippedContent: 'Review-only guidance',
    };
    const flow = new ToolHookFlow({
      debugLog: vi.fn(),
      projectDirectory: process.cwd(),
      ensureSessionRuleSnapshot: async () => [rule],
      buildMatchContext: async () => ({ stage: 'review' }),
      queueMatchedHooks: vi.fn(),
    });

    await expect(
      flow.evaluateAndQueueHooks('PreToolUse', 'session-a', 'bash', { command: 'danger' })
    ).rejects.toThrow('Blocked by rule "review.mdc"');
  });
});
