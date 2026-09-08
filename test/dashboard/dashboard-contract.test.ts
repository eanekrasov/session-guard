import { describe, it, expect } from 'vitest';
import { buildDashboardSchema } from '../../src/dashboard/dashboard-contract.ts';
import type { DashboardInput } from '../../src/dashboard/dashboard-contract.ts';

// Stage ids as a profile writes them, and as dashboard-server passes them.
// The uppercase ids this fixture used to carry appear nowhere in production,
// so the description lookup was asserted against input no caller produces.
const defaultInput: DashboardInput = {
  stages: ['planning', 'execution', 'commit', 'done'],
  transitions: [
    { from: 'planning', to: 'execution' },
    { from: 'execution', to: 'commit' },
    { from: 'commit', to: 'done' },
  ],
  gates: [{ id: 'invariants' }, { id: 'review' }, { id: 'qa' }],
  profile: {
    id: 'test-profile',
    version: '1.0',
    description: 'Test profile',
    invariants: ['LF_ONLY', 'CONSOLE_LOG'],
    agents: ['code', 'review'],
    skills: ['code-review'],
  },
};

describe('buildDashboardSchema', () => {
  it('returns all states with labels and descriptions', () => {
    const schema = buildDashboardSchema(defaultInput);

    expect(schema.states).toHaveLength(4);
    expect(schema.states[0]).toEqual({
      id: 'planning',
      label: 'planning',
      description: 'Planning',
    });
    expect(schema.states[3]).toEqual({
      id: 'done',
      label: 'done',
      description: 'Done',
    });
  });

  it('returns all transitions with shape preserved', () => {
    const schema = buildDashboardSchema(defaultInput);

    expect(schema.transitions).toHaveLength(3);
    expect(schema.transitions[0]).toEqual({
      from: 'planning',
      to: 'execution',
      kind: '',
      gate: null,
    });
  });

  it('copies profile data verbatim', () => {
    const schema = buildDashboardSchema(defaultInput);

    expect(schema.profile).toEqual(defaultInput.profile);
  });

  it('handles empty stages and transitions', () => {
    const empty: DashboardInput = {
      stages: [],
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
      stages: ['DONE'],
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
