import { describe, expect, test } from 'bun:test';

import {
  canonicalScenarios,
  findScenario,
  parityMatrix,
  validateScenarioDefinitions,
  type CanonicalScenario,
} from '../src/registry.ts';
import { scenarioHostOptions } from '../src/host/facade.ts';
import { scenarios as legacyScenarios } from '../src/scenarios/index.ts';

const LEGACY_IDS = [
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
];

describe('the canonical scenario registry', () => {
  test('is the one list both host kinds run, in the order the report numbers them', () => {
    const ids = canonicalScenarios.map((scenario) => scenario.id);

    expect(ids).toEqual(LEGACY_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps the published id, title and profile of every current scenario', () => {
    // `env` is compared too, with one deliberately documented exception: the legacy
    // `plan-consent` set HARNESS_AUTO_APPROVE, which made the plugin grant consent by itself,
    // so the canonical scenario drops it and proves the operator's answer instead.
    const envOverrides: Record<string, string> = {
      'plan-consent':
        'runs without HARNESS_AUTO_APPROVE: the operator answer must be what grants consent',
    };
    for (const scenario of canonicalScenarios) {
      const legacy = legacyScenarios.find((candidate) => candidate.id === scenario.id);
      if (legacy === undefined) throw new Error(`сценарий «${scenario.id}» отсутствует в baseline`);
      expect(scenario.title).toBe(legacy.title);
      expect(scenario.profile).toBe(legacy.profile);
      if (envOverrides[scenario.id] !== undefined) {
        expect(scenario.env).not.toEqual(legacy.env);
        continue;
      }
      expect(scenario.env).toEqual(legacy.env);
    }
  });

  test('holds no V2-only scenario id and no second registry', () => {
    for (const scenario of canonicalScenarios) {
      expect(scenario.id.startsWith('v2-')).toBe(false);
    }
    expect(findScenario('v2-workflow-create')).toBeUndefined();
    expect(findScenario('create')?.migrationState).toBe('migrated');
  });

  test('marks exactly the migrated scenarios so far, and gives them runnable steps', () => {
    const migrated = canonicalScenarios
      .filter((scenario) => scenario.migrationState === 'migrated')
      .map((scenario) => scenario.id);

    expect(migrated).toEqual(['plugin-loads', 'no-session', 'create', 'plan-consent']);
    for (const scenario of canonicalScenarios) {
      if (scenario.migrationState !== 'migrated') {
        expect(scenario.steps).toBeUndefined();
        continue;
      }
      expect(scenario.steps?.length ?? 0).toBeGreaterThan(0);
      for (const step of scenario.steps ?? []) {
        expect(step.instruction.length).toBeGreaterThan(10);
        expect(['read-only', 'mutating']).toContain(step.mutation);
        expect(['same-session', 'new-session', 'poll-state', 'none']).toContain(step.retry);
        expect(typeof step.expect).toBe('function');
      }
    }
  });

  test('fixes the retry strategy of every migrated step in the registry itself', () => {
    // The strategy is a registry decision, not something the runner may infer: a repeat is
    // allowed only where the instruction is read-only, and a mutating instruction is sent once.
    const strategies = Object.fromEntries(
      canonicalScenarios
        .filter((scenario) => scenario.migrationState === 'migrated')
        .map((scenario) => [
          scenario.id,
          scenario.steps?.map((step) => ({
            mutation: step.mutation,
            retry: step.retry,
          })),
        ])
    );

    expect(strategies).toEqual({
      'plugin-loads': [{ mutation: 'read-only', retry: 'same-session' }],
      'no-session': [{ mutation: 'read-only', retry: 'same-session' }],
      create: [{ mutation: 'mutating', retry: 'none' }],
      'plan-consent': [
        { mutation: 'mutating', retry: 'none' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
    });
  });

  test('passes its own validation, and rejects a registry the runner cannot honour', () => {
    expect(validateScenarioDefinitions(canonicalScenarios)).toEqual([]);

    const step = canonicalScenarios.find((scenario) => scenario.id === 'create')!.steps![0]!;
    const bad: CanonicalScenario[] = [
      { id: 'x', title: 'X', migrationState: 'migrated', stage: 'stage-1-core', steps: [step] },
      { id: 'x', title: 'X again', migrationState: 'pending', stage: 'stage-1-core' },
      { id: 'v2-something', title: 'V2 only', migrationState: 'pending', stage: 'stage-1-core' },
      {
        id: 'no-steps',
        title: 'Nothing to run',
        migrationState: 'migrated',
        stage: 'stage-1-core',
        steps: [],
      },
      {
        id: 'unsafe-mutation',
        title: 'Repeats a mutation',
        migrationState: 'migrated',
        stage: 'mutation',
        steps: [{ ...step, mutation: 'mutating', retry: 'same-session' }],
      },
      {
        id: 'unimplemented-retry',
        title: 'Asks for a later stage',
        migrationState: 'migrated',
        stage: 'consent',
        steps: [{ ...step, retry: 'new-session' }],
      },
    ];

    const problems = validateScenarioDefinitions(bad);
    expect(problems.map((problem) => problem.scenarioId)).toEqual([
      'x',
      'v2-something',
      'no-steps',
      'unsafe-mutation',
      'unimplemented-retry',
    ]);
    expect(problems.map((problem) => problem.problem).join('\n')).toContain(
      'duplicate scenario id'
    );
    expect(problems.map((problem) => problem.problem).join('\n')).toContain(
      'may not retry in the same session'
    );
    expect(problems.map((problem) => problem.problem).join('\n')).toContain(
      'retry strategy new-session is not implemented'
    );
  });

  test('gives both host kinds the same metadata, instructions, assertions and retry policy', () => {
    // Structural parity for the real registry, not for a synthetic definition: one scenario
    // definition must produce the same project on V1 and V2, and the only difference the
    // facade is allowed to introduce is which host it starts.
    for (const scenario of canonicalScenarios) {
      if (scenario.migrationState !== 'migrated') continue;
      const common = { 'plan.md': 'plan' };
      const v1 = scenarioHostOptions(scenario, 'v1', 'crpt/model', common);
      const v2 = scenarioHostOptions(scenario, 'v2', 'crpt/model', common);

      expect({ ...v2, kind: 'v1' }).toEqual(v1);
      expect(v1.files).toEqual({ 'plan.md': 'plan' });
      expect(v1.git).toBe(true);
      // The instruction, the mutation class and the retry policy live on the shared definition,
      // so both kinds cannot drift apart on them.
      expect(scenario.steps?.length ?? 0).toBeGreaterThan(0);
      for (const step of scenario.steps ?? []) {
        expect(step.instruction.length).toBeGreaterThan(10);
        expect(['read-only', 'mutating']).toContain(step.mutation);
        expect(typeof step.expect).toBe('function');
      }
    }
  });

  test('describes no-session as a stage-2 scenario with its own assertion, not as a leftover', () => {
    const scenario = canonicalScenarios.find((candidate) => candidate.id === 'no-session');

    expect(scenario).toMatchObject({
      id: 'no-session',
      title: 'Без workflow-сессии плагин не вмешивается в работу',
      migrationState: 'migrated',
      stage: 'stage-2-core',
      agent: 'orchestrator',
    });
    expect(scenario?.steps).toHaveLength(1);
    expect(scenario?.steps?.[0]?.instruction).toContain('git log --oneline -1');
    expect(scenario?.steps?.[0]?.mutation).toBe('read-only');
    expect(scenario?.steps?.[0]?.retry).toBe('same-session');
  });

  test('describes plan-consent as a consent scenario driven by the operator answer', () => {
    const scenario = canonicalScenarios.find((candidate) => candidate.id === 'plan-consent');

    expect(scenario).toMatchObject({
      id: 'plan-consent',
      title: 'Одобренный план переводит сессию из стадии planning',
      migrationState: 'migrated',
      stage: 'consent',
      agent: 'orchestrator',
    });
    // Deliberately without HARNESS_AUTO_APPROVE: the plugin must not grant the consent itself,
    // or the scenario would pass without the operator's answer reaching it.
    expect(scenario?.env ?? {}).toEqual({});
    expect(scenario?.steps).toHaveLength(2);
    expect(scenario?.steps?.[0]?.instruction).toContain('workflow-create');
    expect(scenario?.steps?.[1]?.instruction).toContain('workflow-consent');
    expect(scenario?.steps?.[1]?.instruction).toContain('question');
    expect(scenario?.steps?.[1]?.mutation).toBe('mutating');
    // Consent is never repeated in the same session: the outcome is polled from durable state.
    expect(scenario?.steps?.[1]?.retry).toBe('poll-state');
  });

  test('derives the parity matrix from the registry, requiring every scenario on both hosts', () => {
    const matrix = parityMatrix();

    expect(matrix.map((row) => row.scenarioId)).toEqual(LEGACY_IDS);
    for (const row of matrix) {
      expect(row.requiredOn).toEqual({ v1: true, v2: true });
      expect(row.reason.length).toBeGreaterThan(10);
    }
    const migratedRow = matrix.find((row) => row.scenarioId === 'create');
    expect(migratedRow?.reason).toContain('migrated');
    const pendingRow = matrix.find((row) => row.scenarioId === 'commit-gate');
    expect(pendingRow?.reason).toContain('pending migration');
  });
});
