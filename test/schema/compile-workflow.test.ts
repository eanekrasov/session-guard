import { describe, it, expect } from 'vitest';
import { compileWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';

describe('compileWorkflow', () => {
  it('compiles a simple schema with one stage', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: {
        PLANNING: {
          stages: { dev: {}, review: {} },
        },
        DONE: {
          stages: {},
        },
      },
      transitions: [{ from: 'PLANNING', to: 'DONE', kind: 'auto' }],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'PLANNING' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);

    expect(workflow.version).toBe(1);
    expect(Object.keys(workflow.stages)).toEqual(['PLANNING', 'DONE']);
    expect(workflow.stages.PLANNING.nodes).toHaveLength(2);
    expect(workflow.stages.PLANNING.nodes[0].id).toBe('PLANNING/dev');
    expect(workflow.initialStage).toBe('PLANNING');
    expect(workflow.terminalStages).toContain('DONE');
    expect(workflow.transitions).toHaveLength(1);
    expect(workflow.transitions[0].from).toBe('PLANNING');
    expect(workflow.transitions[0].to).toBe('DONE');
    expect(workflow.transitions[0].kind).toBe('auto');
  });

  it('preserves inherited defaults on undefined fields', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: {
        WORK: {
          stages: { step1: {} },
        },
      },
      transitions: [],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'WORK' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.stages.WORK.loop).toBeNull();
    expect(workflow.stages.WORK.dispatch).toBeNull();
    expect(workflow.stages.WORK.retryBudget).toBeNull();
    expect(workflow.stages.WORK.exitGuards).toEqual([]);
    expect(workflow.stages.WORK.nodes[0].entryGuards).toEqual([]);
    expect(workflow.stages.WORK.nodes[0].exitGuards).toEqual([]);
  });

  it('validates cross-references — unknown source stage', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: { A: {} },
      transitions: [{ from: 'UNKNOWN', to: 'A', kind: 'auto' }],
      stageAssignments: [],
    };

    const { errors } = compileWorkflow(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes('Unknown source stage'))).toBe(true);
  });

  it('validates cross-references — unknown target stage', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: { A: {} },
      transitions: [{ from: 'A', to: 'UNKNOWN', kind: 'auto' }],
      stageAssignments: [],
    };

    const { errors } = compileWorkflow(schema);
    expect(errors.some((e) => e.message.includes('Unknown target stage'))).toBe(true);
  });

  it('returns terminal stages for nodes without outgoing transitions', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: { START: {}, FINISH: {} },
      transitions: [{ from: 'START', to: 'FINISH', kind: 'auto' }],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.terminalStages).toContain('FINISH');
  });

  it('normalises dispatch defaults', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: {
        EXEC: {
          dispatch: { strategy: 'parallel', maxConcurrent: 3 },
          stages: { a: {}, b: {} },
        },
      },
      transitions: [],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'EXEC' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.stages.EXEC.dispatch).toEqual({
      strategy: 'parallel',
      maxConcurrent: 3,
      overlapRoles: [],
    });
  });

  it('handles empty schema gracefully', () => {
    const schema: ResolvedSchema = { source: 'test/empty.yaml' };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.stages).toEqual({});
    expect(workflow.transitions).toEqual([]);
    expect(workflow.stageAssignments).toEqual([]);
    expect(workflow.initialStage).toBe('');
    expect(workflow.terminalStages).toEqual([]);
  });

  it('detects session-wide DONE as terminal', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      stages: { PLANNING: {}, DONE: {} },
      transitions: [{ from: 'PLANNING', to: 'DONE', kind: 'auto' }],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'PLANNING' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.terminalStages).toContain('DONE');
    expect(workflow.terminalStages).not.toContain('PLANNING');
  });

  it('rejects unsupported declarations with diagnostic', () => {
    // Custom checks/executors that don't exist in the current profile-schema should still pass through
    const schema: ResolvedSchema = {
      source: 'test/custom.yaml',
      stages: { MAIN: { stages: { step: {} } } },
      transitions: [],
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'MAIN' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.stages.MAIN).toBeDefined();
  });
});
