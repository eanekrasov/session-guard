import { describe, expect, it } from 'vitest';

import { isWorkflowTaskDescription } from '../../src/app/task-admission.ts';

describe('task admission', () => {
  it('recognizes a workflow task marker and returns its task id', () => {
    expect(isWorkflowTaskDescription('[workflow-task:task-12] implement the change')).toBe(
      'task-12'
    );
  });

  it('does not admit ordinary task descriptions or malformed markers', () => {
    expect(isWorkflowTaskDescription('implement the change')).toBeNull();
    expect(isWorkflowTaskDescription('[workflow-task:task-x] implement the change')).toBeNull();
  });
});
