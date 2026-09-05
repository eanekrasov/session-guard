import { describe, it, expect } from 'vitest';
import { compileWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';

describe('compileWorkflow', () => {
  it('compiles a simple schema with one phase', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: {
        PLANNING: {
          stages: [{ id: 'dev' }, { id: 'review' }],
        },
        DONE: {
          stages: [],
        },
      },
      transitions: [{ from: 'PLANNING', to: 'DONE', kind: 'auto' }],
      phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'PLANNING' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);

    expect(workflow.version).toBe(1);
    expect(Object.keys(workflow.phases)).toEqual(['PLANNING', 'DONE']);
    expect(workflow.phases.PLANNING.nodes).toHaveLength(2);
    expect(workflow.phases.PLANNING.nodes[0].id).toBe('PLANNING/dev');
    expect(workflow.initialPhase).toBe('PLANNING');
    expect(workflow.terminalPhases).toContain('DONE');
    expect(workflow.transitions).toHaveLength(1);
    expect(workflow.transitions[0].from).toBe('PLANNING');
    expect(workflow.transitions[0].to).toBe('DONE');
    expect(workflow.transitions[0].kind).toBe('auto');
  });

  it('preserves inherited defaults on undefined fields', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: {
        WORK: {
          stages: [{ id: 'step1' }],
        },
      },
      transitions: [],
      phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'WORK' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.phases.WORK.loop).toBeNull();
    expect(workflow.phases.WORK.dispatch).toBeNull();
    expect(workflow.phases.WORK.retryBudget).toBeNull();
    expect(workflow.phases.WORK.exitGuards).toEqual([]);
    expect(workflow.phases.WORK.nodes[0].entryGuards).toEqual([]);
    expect(workflow.phases.WORK.nodes[0].exitGuards).toEqual([]);
  });

  it('validates cross-references — unknown source phase', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: { A: {} },
      transitions: [{ from: 'UNKNOWN', to: 'A', kind: 'auto' }],
      phaseAssignments: [],
    };

    const { errors } = compileWorkflow(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes('Unknown source phase'))).toBe(true);
  });

  it('validates cross-references — unknown target phase', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: { A: {} },
      transitions: [{ from: 'A', to: 'UNKNOWN', kind: 'auto' }],
      phaseAssignments: [],
    };

    const { errors } = compileWorkflow(schema);
    expect(errors.some((e) => e.message.includes('Unknown target phase'))).toBe(true);
  });

  it('returns terminal phases for nodes without outgoing transitions', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: { START: {}, FINISH: {} },
      transitions: [{ from: 'START', to: 'FINISH', kind: 'auto' }],
      phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'START' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.terminalPhases).toContain('FINISH');
  });

  it('normalises dispatch defaults', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: {
        EXEC: {
          dispatch: { strategy: 'parallel', maxConcurrent: 3 },
          stages: [{ id: 'a' }, { id: 'b' }],
        },
      },
      transitions: [],
      phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'EXEC' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.phases.EXEC.dispatch).toEqual({
      strategy: 'parallel',
      maxConcurrent: 3,
      overlapRoles: [],
    });
  });

  it('handles empty schema gracefully', () => {
    const schema: ResolvedSchema = { source: 'test/empty.yaml' };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.phases).toEqual({});
    expect(workflow.transitions).toEqual([]);
    expect(workflow.phaseAssignments).toEqual([]);
    expect(workflow.initialPhase).toBe('');
    expect(workflow.terminalPhases).toEqual([]);
  });

  it('detects session-wide DONE as terminal', () => {
    const schema: ResolvedSchema = {
      source: 'test/cycle.yaml',
      phases: { PLANNING: {}, DONE: {} },
      transitions: [{ from: 'PLANNING', to: 'DONE', kind: 'auto' }],
      phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'PLANNING' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.terminalPhases).toContain('DONE');
    expect(workflow.terminalPhases).not.toContain('PLANNING');
  });

  it('rejects unsupported declarations with diagnostic', () => {
    // Custom checks/executors that don't exist in the current profile-schema should still pass through
    const schema: ResolvedSchema = {
      source: 'test/custom.yaml',
      phases: { MAIN: { stages: [{ id: 'step' }] } },
      transitions: [],
      phaseAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'MAIN' }],
    };

    const { workflow, errors } = compileWorkflow(schema);
    expect(errors).toHaveLength(0);
    expect(workflow.phases.MAIN).toBeDefined();
  });
});
