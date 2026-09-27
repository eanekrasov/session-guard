import { describe, expect, test } from 'bun:test';

import { scenarios } from '../src/scenarios/index.ts';

/**
 * The registry is what the runner iterates and what the report numbers. A scenario that exists as a
 * file but is missing here would silently stop running — the one failure a file-per-scenario split
 * invites — so the list, its order and its shape are pinned.
 */
describe('the V1 scenario registry', () => {
  test('lists every scenario once, in the order the report numbers them', () => {
    const ids = scenarios.map((scenario) => scenario.id);

    expect(ids).toEqual([
      'plugin-loads',
      'no-session',
      'create',
      'git-block',
      'task-control',
      'commit-gate',
      'plan-consent',
      'commit-cwd',
      'commit-mismatch',
      'cicd-full-cycle',
      'verify-loop',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('gives every scenario a title, a runner and a known profile', () => {
    for (const scenario of scenarios) {
      expect(scenario.title.length).toBeGreaterThan(10);
      expect(typeof scenario.run).toBe('function');
      if (scenario.profile !== undefined) {
        expect(['smoke', 'cicd']).toContain(scenario.profile);
      }
    }
  });

  test('bypasses the operator answer only where the profile expects it', () => {
    const autoApproved = scenarios
      .filter((scenario) => scenario.env?.HARNESS_AUTO_APPROVE === 'true')
      .map((scenario) => scenario.id);

    expect(autoApproved).toEqual([
      'plan-consent',
      'commit-cwd',
      'commit-mismatch',
      'cicd-full-cycle',
      'verify-loop',
    ]);
  });
});
