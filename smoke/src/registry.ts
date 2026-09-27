/**
 * The one canonical scenario registry.
 *
 * A single list serves both host kinds: the runner picks a host kind, never a scenario list.
 * Migration state is registry metadata and is deliberately separate from runnable status —
 * a `pending` scenario keeps its canonical id, title and inputs for the parity report, and
 * produces no scenario result at all.
 */

import { SHELL_TOOL } from './host/transport.ts';
import type {
  HostKind,
  NormalizedInteraction,
  NormalizedToolCall,
  ScenarioDefinition,
  ScenarioStep,
} from './host/types.ts';

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

/** Creating the workflow session; `create` and every later stage start with it. */
const workflowCreateStep: ScenarioStep = {
  instruction:
    'Call the tool `workflow-create` with schemaId "smoke". Do nothing else and add no commentary.',
  // Creating the session changes durable state, so it is never repeated in the same
  // session: the runner keeps a single attempt and reports an unprovable outcome
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

/** Prepare the consent tag, then ask the operator with it, exactly as the plugin expects. */
const CONSENT_INSTRUCTION =
  'Do this in two tool calls and nothing else. ' +
  'First call `workflow-consent` with files ["plan.md"] and summary "smoke plan". ' +
  'Then call the `question` tool once, passing as the question text the ENTIRE ' +
  '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
  'character for character, with options labelled "grant" and "decline".';

/**
 * Consent is a mutation of the workflow's own state, so its outcome is read from that state
 * rather than from the answer: the plan reference must be recorded and the machine must have
 * left `planning`. `poll-state` is what makes that safe — the instruction is sent once, and
 * only the durable store is read afterwards.
 */
const consentStep: ScenarioStep = {
  instruction: CONSENT_INSTRUCTION,
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const state = result.workflowState;
    if (state === null) return 'сессия workflow отсутствует после согласия';
    // The consent path itself is what must be proven: a grant for some other question the model
    // invented would otherwise satisfy this assertion while proving nothing.
    const consent = (result.interactions ?? []).find(
      (entry) => entry.isConsent && entry.decision === 'grant'
    );
    if (consent === undefined) {
      return `согласие не было задано и отвечено через общий фасад: interactions=${JSON.stringify(
        (result.interactions ?? []).map(
          (entry) => `${entry.kind}:${entry.decision}:consent=${entry.isConsent}`
        )
      ).slice(0, 200)}`;
    }
    if (state.refs?.plan === undefined) {
      return `ссылка на план не записана: refs=${JSON.stringify(state.refs ?? {}).slice(0, 200)}`;
    }
    const stage = state.currentStage ?? '(не задана)';
    return stage === 'tasks_ready' || `стадия — ${stage}, ожидалась tasks_ready`;
  },
};

/** The exact command the scenario asks for; the assertion proves this is what ran. */
const NO_SESSION_COMMAND = 'git log --oneline -1';

/** Spacing is not a finding: the command is compared after collapsing whitespace. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, ' ');
}

const noSessionStep: ScenarioStep = {
  instruction: `Use the bash tool to run exactly this command: ${NO_SESSION_COMMAND}. Do nothing else.`,
  // The command is read-only, so a repeat in the same session is allowed.
  mutation: 'read-only',
  retry: 'same-session',
  expect: (result) => {
    // The scenario owns the boundary of an unmanaged session, so its contract is "exactly the
    // allowed action": an extra shell call could change the working tree or the environment even
    // when it looks harmless. Only tool calls are counted — text after the call is not an action.
    if (result.workflowState !== null) {
      return `плагин записал сессию workflow для неуправляемой сессии: ${JSON.stringify(
        result.workflowState
      ).slice(0, 200)}`;
    }
    const calls = result.turn.toolCalls;
    if (calls.length === 0)
      return 'разрешённое действие не выполнено: ни одного вызова инструмента';
    if (calls.length > 1) {
      return (
        `разрешено ровно одно действие, а выполнено ${calls.length}: ${describeCalls(calls)}; ` +
        'инструкция требует «Do nothing else»'
      );
    }
    const call = calls[0]!;
    if (call.name !== SHELL_TOOL) {
      return `разрешён инструмент «${SHELL_TOOL}», а вызван «${call.name}»`;
    }
    if (call.status !== 'completed') {
      return `действие не завершилось: ${call.name}:${call.status}`;
    }
    if (normalizeCommand(call.command ?? '') !== NO_SESSION_COMMAND) {
      return `выполнена не та команда: «${
        call.command ?? '(команда не сообщена)'
      }»; ожидалась «${NO_SESSION_COMMAND}»`;
    }
    if (!(call.output ?? '').includes('seed')) {
      return `вывод не содержит seed-коммит: ${(call.output ?? '(пусто)').slice(0, 120)}`;
    }
    return true;
  },
};

/** A compact, structured list of calls for a step's failure evidence. */
function describeCalls(calls: NormalizedToolCall[]): string {
  return calls
    .map(
      (call) =>
        `${call.name}:${call.status}${call.command === undefined ? '' : ` «${call.command.slice(0, 60)}»`}`
    )
    .join(', ');
}

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
    migrationState: 'migrated',
    stage: 'stage-2-core',
    agent: ORCHESTRATOR,
    steps: [noSessionStep],
  },
  {
    id: 'create',
    title: 'workflow-create передаёт сессию под управление конечного автомата',
    migrationState: 'migrated',
    stage: 'stage-1-core',
    agent: ORCHESTRATOR,
    steps: [workflowCreateStep],
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
    migrationState: 'migrated',
    stage: 'consent',
    agent: ORCHESTRATOR,
    // The legacy baseline set HARNESS_AUTO_APPROVE here, which made the plugin grant the
    // consent by itself; the canonical scenario deliberately runs without it, so the only way
    // to reach `tasks_ready` is the operator's answer travelling through the facade.
    steps: [workflowCreateStep, consentStep],
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
      if (step.retry === 'new-session') {
        problems.push({
          scenarioId: scenario.id,
          problem: `${where}: retry strategy new-session is not implemented in this stage`,
        });
      }
    });
  }
  return problems;
}
