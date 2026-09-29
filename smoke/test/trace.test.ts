import { describe, expect, test } from 'bun:test';

import { formatToolTrace, summarizeWorkflowCheckpoint } from '../src/trace.ts';
import type { NormalizedToolCall, SmokeWorkflowState } from '../src/host/types.ts';

describe('smoke diagnostic trace', () => {
  test('formats the tool list with statuses instead of collapsing it to one failure', () => {
    const calls: NormalizedToolCall[] = [
      { name: 'task', status: 'pending' },
      { name: 'workflow-result', status: 'completed' },
    ];

    expect(formatToolTrace(calls)).toBe('tools=[task:pending, workflow-result:completed]');
    expect(formatToolTrace([])).toBe('tools=[]');
  });

  test('summarizes durable revision, stage, and gates', () => {
    const state = {
      sessionId: 'ses-1',
      status: 'running',
      currentStage: 'review',
      stageGates: { review: 'absent', qa: 'passed' },
      durableMutation: 'applied',
    } satisfies SmokeWorkflowState;

    expect(summarizeWorkflowCheckpoint(state, 7)).toBe(
      'revision=7 stage=review gates=[review:absent, qa:passed]'
    );
    expect(summarizeWorkflowCheckpoint(null)).toBe('revision=unknown stage=(none) gates=[]');
  });
});
