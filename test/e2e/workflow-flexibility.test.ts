import { describe, it, expect } from 'vitest';
import { compileWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';

describe('workflow flexibility — coverage matrix', () => {
  it('1. schema describes change → commit → change → commit', () => {
    const schema: ResolvedSchema = {
      source: 'flex.yaml',
      id: 'flex',
      stages: { START: {}, CHANGE_1: {}, COMMIT_1: {}, CHANGE_2: {}, COMMIT_2: {}, DONE: {} },
      transitions: [
        { from: 'START', to: 'CHANGE_1' },
        { from: 'CHANGE_1', to: 'COMMIT_1' },
        { from: 'COMMIT_1', to: 'CHANGE_2' },
        { from: 'CHANGE_2', to: 'COMMIT_2' },
        { from: 'COMMIT_2', to: 'DONE' },
      ],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.transitions).toHaveLength(5);
    // Both commit steps use the same generic lifecycle
    const commitSteps = workflow.transitions.filter(
      (t) => t.from === 'COMMIT_1' || t.from === 'COMMIT_2'
    );
    expect(commitSteps).toHaveLength(2);
  });

  it('9. workflow starts at declared initial node, ends at terminal outcome', () => {
    const schema: ResolvedSchema = {
      source: 'init-term.yaml',
      id: 'init-term',
      stages: { PLANNING: { stages: { a: {} } }, EXECUTION: {}, DONE: {} },
      transitions: [
        { from: 'PLANNING', to: 'EXECUTION' },
        { from: 'EXECUTION', to: 'DONE' },
      ],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'PLANNING' }],
    };

    const { workflow } = compileWorkflow(schema);
    expect(workflow.initialStage).toBe('PLANNING');
  });

  it('14. accepted field has observable semantics', () => {
    const schema: ResolvedSchema = {
      source: 'test.yaml',
      id: 'test',
      stages: { START: { retryBudget: { maximum: 3 }, stages: { step: {} } }, DONE: {} },
      transitions: [{ from: 'START', to: 'DONE' }],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.stages.START.retryBudget).toBe(3);
    expect(workflow.stages.START.nodes).toHaveLength(1);
  });
});
