/**
 * The one canonical scenario registry.
 *
 * A single list serves both host kinds: the runner picks a host kind, never a scenario list.
 * Migration state is registry metadata and is deliberately separate from runnable status —
 * a `pending` scenario keeps its canonical id, title and inputs for the parity report, and
 * produces no scenario result at all.
 */

import type { HostKind, ScenarioDefinition, ScenarioStep } from './host/types.ts';

/** Which migration stage a scenario belongs to; the parity matrix is derived from it. */
export type ScenarioStage =
  'stage-1-core' | 'stage-2-core' | 'consent' | 'task' | 'mutation' | 'pipeline';

export type CanonicalScenario = ScenarioDefinition & {
  stage: ScenarioStage;
};

export const ORCHESTRATOR = 'orchestrator';

/**
 * The plugin's own tool surface is `workflow-*`, so a call to one of those tools is what
 * "the plugin loaded" means observably; prose in the transcript is not evidence.
 */
const PLUGIN_TOOL = 'workflow-list';

const pluginLoadsStep: ScenarioStep = {
  instruction:
    'Call the tool `workflow-list` with no arguments, then reply with its output verbatim.',
  mutation: 'read-only',
  retry: 'same-session',
  expect: (result) => {
    const evidence = result.pluginEvidence;
    if (!evidence.loaded) return 'хост не сообщил ни одного вызова инструмента плагина';
    if (evidence.hostOperation !== 'real-host') {
      return `доказательство получено не от живого хоста (${evidence.hostOperation})`;
    }
    const call = evidence.invokedTools.find((entry) => entry.name === PLUGIN_TOOL);
    if (!call) return `tool «${PLUGIN_TOOL}» не был вызван через хост`;
    if (call.status !== 'completed') {
      return `tool «${PLUGIN_TOOL}» завершился со статусом ${call.status}`;
    }
    const output = call.output ?? '';
    if (!output.includes('profilesDir') || !output.includes('smoke')) {
      return `tool «${PLUGIN_TOOL}» не сообщил профили проекта: ${output.slice(0, 300)}`;
    }
    if (evidence.result !== 'success') {
      return `структурированный результат плагина — ${evidence.result}`;
    }
    return true;
  },
};

const createStep: ScenarioStep = {
  instruction:
    'Call the tool `workflow-create` with schemaId "smoke". Do nothing else and add no commentary.',
  // Creating the session changes durable state, so it is never repeated in the same
  // session: stage 1 keeps a single attempt and the runner reports an unprovable outcome
  // instead of a second mutation.
  mutation: 'mutating',
  retry: 'none',
  expect: (result) => {
    const state = result.workflowState;
    if (state === null) return 'сессия workflow не сохранена';
    const stage = state.currentStage ?? '(не задана)';
    return stage === 'planning' || `стадия — ${stage}, ожидалась planning`;
  },
};

/**
 * The canonical scenarios, in the order the report numbers them. Ids and titles are the
 * ones the suite already published; a scenario is never dropped from one host kind only.
 */
export const canonicalScenarios: CanonicalScenario[] = [
  {
    id: 'plugin-loads',
    title: 'Хост загружает упакованный плагин и регистрирует его инструменты',
    migrationState: 'migrated',
    stage: 'stage-1-core',
    agent: ORCHESTRATOR,
    steps: [pluginLoadsStep],
  },
  {
    id: 'no-session',
    title: 'Без workflow-сессии плагин не вмешивается в работу',
    migrationState: 'pending',
    stage: 'stage-2-core',
  },
  {
    id: 'create',
    title: 'workflow-create передаёт сессию под управление конечного автомата',
    migrationState: 'migrated',
    stage: 'stage-1-core',
    agent: ORCHESTRATOR,
    steps: [createStep],
  },
  {
    id: 'git-block',
    title: 'Прямой git commit отклоняется внутри управляемой сессии',
    migrationState: 'pending',
    // `git-block` is the one current scenario the stage classes do not name. It drives a git
    // mutation and expects the workflow guard to refuse it, which is what the `mutation`
    // class covers, so it migrates with that class rather than in a class of its own.
    stage: 'mutation',
  },
  {
    id: 'task-control',
    title: 'Только orchestrator может изменять состояние задач workflow',
    migrationState: 'pending',
    stage: 'task',
  },
  {
    id: 'commit-gate',
    title: 'commit-task отклоняется, пока гейты не пройдены',
    migrationState: 'pending',
    stage: 'mutation',
  },
  {
    id: 'plan-consent',
    title: 'Одобренный план переводит сессию из стадии planning',
    migrationState: 'pending',
    stage: 'consent',
    env: { HARNESS_AUTO_APPROVE: 'true' },
  },
  {
    id: 'commit-cwd',
    title: 'Коммит, соответствующий разрешению, получает квитанцию',
    migrationState: 'pending',
    stage: 'mutation',
    env: { HARNESS_AUTO_APPROVE: 'true' },
  },
  {
    id: 'commit-mismatch',
    title: 'Коммит с посторонним файлом не получает квитанцию',
    migrationState: 'pending',
    stage: 'mutation',
    env: { HARNESS_AUTO_APPROVE: 'true' },
  },
  {
    id: 'cicd-full-cycle',
    title:
      'Полный CI/CD-пайплайн: init → checkout → build → test(unit+integration) → deploy → smoke → done',
    migrationState: 'pending',
    stage: 'pipeline',
    profile: 'cicd',
    env: { HARNESS_AUTO_APPROVE: 'true' },
  },
  {
    id: 'verify-loop',
    title: 'Живой субагент закрывает гейт собственным workflow-result',
    migrationState: 'pending',
    stage: 'task',
    env: { HARNESS_AUTO_APPROVE: 'true' },
  },
];

export function findScenario(id: string): CanonicalScenario | undefined {
  return canonicalScenarios.find((scenario) => scenario.id === id);
}

export interface ScenarioMatrixRow {
  scenarioId: string;
  requiredOn: Record<HostKind, boolean>;
  expectedStatus: 'pass';
  reason: string;
}

/**
 * The parity matrix, derived from the registry rather than maintained by hand. Every
 * canonical scenario is required on both host kinds: one registry with no per-kind list is
 * what the suite exists to prove.
 */
export function parityMatrix(
  scenarios: CanonicalScenario[] = canonicalScenarios
): ScenarioMatrixRow[] {
  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    requiredOn: { v1: true, v2: true },
    expectedStatus: 'pass',
    reason:
      scenario.migrationState === 'migrated'
        ? `${scenario.stage}: migrated, runnable through both host kinds`
        : `${scenario.stage}: pending migration, not-run until its stage`,
  }));
}

export interface DefinitionProblem {
  scenarioId: string;
  problem: string;
}

/**
 * A registry that cannot run must fail before a host is started, not in the middle of a
 * live run. Every rule here is a boundary of the current stage or of the retry contract.
 */
export function validateScenarioDefinitions(
  scenarios: CanonicalScenario[] = canonicalScenarios
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      problems.push({ scenarioId: scenario.id, problem: 'duplicate scenario id' });
    }
    seen.add(scenario.id);
    if (scenario.id.startsWith('v2-')) {
      problems.push({
        scenarioId: scenario.id,
        problem: 'a V2-only id is not a canonical scenario: one registry serves both host kinds',
      });
    }
    if (scenario.migrationState !== 'migrated') continue;
    const steps = scenario.steps ?? [];
    if (steps.length === 0) {
      problems.push({
        scenarioId: scenario.id,
        problem: 'a migrated scenario must declare at least one runnable step',
      });
    }
    steps.forEach((step, index) => {
      const where = `step ${index + 1}`;
      if (step.mutation === 'mutating' && step.retry === 'same-session') {
        problems.push({
          scenarioId: scenario.id,
          problem: `${where}: a mutating step may not retry in the same session`,
        });
      }
      if (step.retry === 'poll-state' || step.retry === 'new-session') {
        problems.push({
          scenarioId: scenario.id,
          problem: `${where}: retry strategy ${step.retry} is not implemented in this stage`,
        });
      }
    });
  }
  return problems;
}
