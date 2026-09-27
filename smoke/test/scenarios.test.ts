import { describe, expect, test } from 'bun:test';

import { scenarios, v2Scenarios } from '../src/scenarios/index.ts';

/**
 * Исполнитель перебирает реестр и нумерует отчёт. Сценарий, существующий в виде файла,
 * но отсутствующий здесь, перестал бы выполняться без предупреждения — это единственный сбой,
 * к которому располагает разбиение по файлу на сценарий, — поэтому список, его порядок и форма закреплены.
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

describe('the V2 scenario registry', () => {
  test('lists every scenario once, in the order its run reports them', () => {
    const ids = v2Scenarios.map((scenario) => scenario.id);

    expect(ids).toEqual(['v2-workflow-create', 'v2-workflow-consent', 'v2-workflow-tasks']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('drives every scenario as the orchestrator, with at least one step', () => {
    for (const scenario of v2Scenarios) {
      expect(scenario.title.length).toBeGreaterThan(10);
      expect(scenario.agent).toBe('orchestrator');
      expect(scenario.steps.length).toBeGreaterThan(0);
      for (const step of scenario.steps) {
        expect(step.instruction.length).toBeGreaterThan(10);
        expect(typeof step.expect).toBe('function');
      }
    }
  });
});
