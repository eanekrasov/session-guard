import { describe, it, expect } from 'vitest';
import { buildDashboardSchema } from '../../src/dashboard/dashboard-contract.ts';
import type { DashboardInput } from '../../src/dashboard/dashboard-contract.ts';

const defaultInput: DashboardInput = {
  phases: ['PLANNING', 'EXECUTION', 'COMMIT', 'DONE'],
  transitions: [
    { from: 'PLANNING', to: 'EXECUTION' },
    { from: 'EXECUTION', to: 'COMMIT' },
    { from: 'COMMIT', to: 'DONE' },
  ],
  gates: [{ id: 'invariants' }, { id: 'review' }, { id: 'qa' }],
  profile: {
    id: 'test-profile',
    version: '1.0',
    description: 'Test profile',
    invariants: ['LF_ONLY', 'CONSOLE_LOG'],
    mandatoryStages: ['review', 'qa'],
    agents: ['code', 'review'],
    skills: ['code-review'],
  },
};

describe('buildDashboardSchema', () => {
  it('returns all states with labels and descriptions', () => {
    const schema = buildDashboardSchema(defaultInput);

    expect(schema.states).toHaveLength(4);
    expect(schema.states[0]).toEqual({
      id: 'PLANNING',
      label: 'PLANNING',
      description: 'Planning',
    });
    expect(schema.states[3]).toEqual({
      id: 'DONE',
      label: 'DONE',
      description: 'Done',
    });
  });

  it('returns all transitions with shape preserved', () => {
    const schema = buildDashboardSchema(defaultInput);

    expect(schema.transitions).toHaveLength(3);
    expect(schema.transitions[0]).toEqual({
      from: 'PLANNING',
      to: 'EXECUTION',
      kind: '',
      gate: null,
    });
  });

  it('marks gates as required based on mandatoryStages', () => {
    const schema = buildDashboardSchema(defaultInput);

    const invariants = schema.gates.find((g) => g.id === 'invariants')!;
    const review = schema.gates.find((g) => g.id === 'review')!;
    const qa = schema.gates.find((g) => g.id === 'qa')!;

    expect(invariants.required).toBe(false);
    expect(review.required).toBe(true);
    expect(qa.required).toBe(true);
  });

  it('copies profile data verbatim', () => {
    const schema = buildDashboardSchema(defaultInput);

    expect(schema.profile).toEqual(defaultInput.profile);
  });

  it('handles empty phases and transitions', () => {
    const empty: DashboardInput = {
      phases: [],
      transitions: [],
      gates: [],
      profile: defaultInput.profile,
    };

    const schema = buildDashboardSchema(empty);

    expect(schema.states).toEqual([]);
    expect(schema.transitions).toEqual([]);
    expect(schema.gates).toEqual([]);
  });

  it('handles single state', () => {
    const single: DashboardInput = {
      ...defaultInput,
      phases: ['DONE'],
    };

    const schema = buildDashboardSchema(single);

    expect(schema.states).toHaveLength(1);
    expect(schema.states[0].id).toBe('DONE');
  });

  it('labels gates with human-readable labels', () => {
    const schema = buildDashboardSchema(defaultInput);

    const review = schema.gates.find((g) => g.id === 'review')!;
    expect(review.label).toBe('Code review');
  });

  it('falls back to gate id for unknown gates', () => {
    const custom = {
      ...defaultInput,
      gates: [...defaultInput.gates, { id: 'custom-gate' }],
    };

    const schema = buildDashboardSchema(custom);

    const customGate = schema.gates.find((g) => g.id === 'custom-gate')!;
    expect(customGate.label).toBe('custom-gate');
  });
});
