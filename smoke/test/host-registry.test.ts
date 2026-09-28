import { describe, expect, test } from 'bun:test';

import {
  canonicalScenarios,
  findScenario,
  parityMatrix,
  validateScenarioDefinitions,
  type CanonicalScenario,
} from '../src/registry.ts';
import { scenarioHostOptions } from '../src/host/facade.ts';

/**
 * Канонический порядок: базовые сценарии плюс `workflow-result`, у которого нет legacy-версии —
 * он проверяет сам механизм вердикта и появился уже после перехода на один реестр.
 */
const CANONICAL_IDS = [
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
  'workflow-result',
  'verify-loop',
];

describe('the canonical scenario registry', () => {
  test('is the one list both host kinds run, in the order the report numbers them', () => {
    const ids = canonicalScenarios.map((scenario) => scenario.id);

    expect(ids).toEqual(CANONICAL_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps the published id, title and env of every baseline scenario', () => {
    // Раньше это сверялось с legacy-реестром; он удалён вместе с compatibility bridge, поэтому
    // опубликованный контракт живёт здесь. Два сценария отмечены явно: canonical-варианты
    // `plan-consent` и `verify-loop` сознательно не выставляют `HARNESS_AUTO_APPROVE`, чтобы
    // согласие давал оператор, а не плагин сам себе. `workflow-result` появился после перехода на
    // один реестр и базовой версии не имеет.
    const published: Record<string, { title: string; env?: Record<string, string> }> = {
      'plugin-loads': {
        title: 'Хост загружает упакованный плагин и регистрирует его инструменты',
      },
      'no-session': { title: 'Без workflow-сессии плагин не вмешивается в работу' },
      create: { title: 'workflow-create передаёт сессию под управление конечного автомата' },
      'git-block': { title: 'Прямой git commit отклоняется внутри управляемой сессии' },
      'task-control': {
        title: 'Только orchestrator может изменять состояние задач workflow',
      },
      'commit-gate': { title: 'commit-task отклоняется, пока гейты не пройдены' },
      'plan-consent': { title: 'Одобренный план переводит сессию из стадии planning' },
      'commit-cwd': {
        title: 'Коммит, соответствующий разрешению, получает квитанцию',
        env: { HARNESS_AUTO_APPROVE: 'true' },
      },
      'commit-mismatch': {
        title: 'Коммит с посторонним файлом не получает квитанцию',
        env: { HARNESS_AUTO_APPROVE: 'true' },
      },
      'cicd-full-cycle': {
        title:
          'Полный CI/CD-пайплайн: init → checkout → build → test(unit+integration) → deploy → smoke → done',
        env: { HARNESS_AUTO_APPROVE: 'true' },
      },
      'verify-loop': { title: 'Живой субагент закрывает гейт собственным workflow-result' },
    };

    for (const scenario of canonicalScenarios) {
      const baseline = published[scenario.id];
      if (baseline === undefined) {
        expect(scenario.id).toBe('workflow-result');
        continue;
      }
      expect(scenario.title).toBe(baseline.title);
      expect(scenario.env).toEqual(baseline.env);
      if (scenario.id === 'cicd-full-cycle') expect(scenario.profile).toBe('cicd');
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

    expect(migrated).toEqual([
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
      'workflow-result',
      'verify-loop',
    ]);
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
      create: [{ mutation: 'mutating', retry: 'poll-state' }],
      // The guarded commit is a mutation that must not be repeated: the expected refusal is an
      // outcome, not something to retry, and a repeat after a timeout could commit for real.
      'git-block': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'none' },
      ],
      // Ранняя поставка — mutation, но её исход читается из состояния: HEAD, разрешение и
      // квитанция. Поэтому шаг ждёт durable-исход, а не повторяет команду.
      'commit-gate': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
      'commit-cwd': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
      // Pipeline: длинные шаги объявляют свои пределы, но стратегия та же — инструкция одна,
      // дальше читается состояние.
      'cicd-full-cycle': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
      // Проверка вердикта: один шаг — сессия сажается сразу на стадию с гейтом.
      'workflow-result': [{ mutation: 'mutating', retry: 'poll-state' }],
      'commit-mismatch': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
      'task-control': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'read-only', retry: 'same-session' },
      ],
      'plan-consent': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
      'verify-loop': [
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
        { mutation: 'mutating', retry: 'poll-state' },
      ],
    });
  });

  test('leaves nothing pending: every canonical scenario is migrated and runnable', () => {
    const pending = canonicalScenarios
      .filter((scenario) => scenario.migrationState === 'pending')
      .map((scenario) => scenario.id);

    expect(pending).toEqual([]);
    expect(canonicalScenarios).toHaveLength(12);
    for (const scenario of canonicalScenarios) {
      expect(scenario.migrationState).toBe('migrated');
      expect(scenario.steps?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('runs every scenario on both host kinds, so no leg can be not-run', () => {
    const matrix = parityMatrix();

    expect(matrix).toHaveLength(canonicalScenarios.length);
    for (const row of matrix) {
      expect(row.requiredOn).toEqual({ v1: true, v2: true });
    }
    // Два хоста на сценарий — это ровно тот набор ног, который отчёт обязан заполнить.
    const legs = matrix.length * 2;
    expect(legs).toBe(canonicalScenarios.length * 2);
  });

  test('requires the guarded commit on both host kinds and expects the same semantics', () => {
    const row = parityMatrix().find((entry) => entry.scenarioId === 'git-block');

    expect(row).toBeDefined();
    expect(row?.requiredOn).toEqual({ v1: true, v2: true });
    expect(row?.expectedStatus).toBe('pass');
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

    expect(matrix.map((row) => row.scenarioId)).toEqual(CANONICAL_IDS);
    for (const row of matrix) {
      expect(row.requiredOn).toEqual({ v1: true, v2: true });
      expect(row.reason.length).toBeGreaterThan(10);
    }
    for (const row of matrix) {
      expect(row.reason).toContain('migrated');
      expect(row.reason).not.toContain('pending migration');
    }
  });
});
