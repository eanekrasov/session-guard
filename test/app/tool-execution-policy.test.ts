import { describe, expect, it } from 'vitest';

import { createToolExecutionPolicy } from '../../src/app/tool-execution-policy.ts';

describe('tool execution policy', () => {
  it('keeps the authorization pipeline explicit and ordered', async () => {
    const calls: string[] = [];
    const policy = createToolExecutionPolicy({
      guardrails: async () => {
        calls.push('guardrails');
      },
      rules: async () => {
        calls.push('rules');
      },
      consent: async () => {
        calls.push('consent');
        return false;
      },
      taskAdmission: {
        isWorkflowTask: () => true,
        before: async () => {
          calls.push('task-admission');
        },
      },
      taskInput: (input) => ({ ...input, output: { args: input.args }, session: {} as never }),
      scope: async () => {
        calls.push('scope');
      },
      actions: async () => {
        calls.push('actions');
      },
      delivery: async () => {
        calls.push('delivery');
      },
      mutation: async () => {
        calls.push('mutation');
      },
    });

    await policy.before({ tool: 'write', sessionID: 'session', callID: 'call', args: {} });

    expect(calls).toEqual([
      'guardrails',
      'rules',
      'consent',
      'task-admission',
      'scope',
      'actions',
      'delivery',
      'mutation',
    ]);
  });

  it('stops the pipeline when an earlier policy refuses', async () => {
    const calls: string[] = [];
    const policy = createToolExecutionPolicy({
      guardrails: async () => {
        calls.push('guardrails');
      },
      rules: async () => {
        calls.push('rules');
        throw new Error('blocked');
      },
      consent: async () => {
        calls.push('consent');
        return false;
      },
      scope: async () => {
        calls.push('scope');
      },
      actions: async () => {
        calls.push('actions');
      },
      delivery: async () => {
        calls.push('delivery');
      },
      mutation: async () => {
        calls.push('mutation');
      },
    });

    await expect(
      policy.before({ tool: 'write', sessionID: 'session', callID: 'call', args: {} })
    ).rejects.toThrow('blocked');
    expect(calls).toEqual(['guardrails', 'rules']);
  });
});
