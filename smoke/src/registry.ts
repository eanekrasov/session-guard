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
  SmokeWorkflowState,
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
  // Creating the session changes durable state, so its instruction is never repeated. The
  // outcome is a session at `planning`, which the store shows, so `poll-state` waits for it
  // instead of blocking on a turn that outlived the prompt budget.
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const state = result.workflowState;
    if (state === null) return 'сессия workflow не сохранена';
    const stage = state.currentStage ?? '(не задана)';
    return stage === 'planning' || `стадия — ${stage}, ожидалась planning`;
  },
};

/** The one task list the smoke profile declares, with a single task the orchestrator owns. */
/** How long one step may take to appear in the store, when the step does not say. */
export const DEFAULT_STEP_STATE_BUDGET_MS = 5_000;

/** The refusal sentence the plugin's task guard answers with, used only as a fallback. */
const TASK_REFUSAL_SENTENCE = /is refused/i;

/**
 * The refusal sentence a blocked direct commit is reported with. Only a fallback: the proof is
 * the structured signal — the plugin's `metadata.refused`, or the host's error for the refused
 * call — and the durable state. The wording is read when a host reports neither, which V2's tool
 * wrapper can do because it drops the metadata; the durable state stays the primary proof.
 */
const COMMIT_REFUSAL_SENTENCE = /refus|not allowed|no entry covers|not permitted|blocked/i;

/**
 * The guarded attempt: a direct `git commit` inside a managed session is refused by the plugin's
 * stage action table, and the durable state is left without any permission to deliver.
 *
 * The instruction is sent once (`retry: none`). The command changes git state, so a repeat after
 * a timeout could produce a different outcome, and an expected refusal never needs one: there is
 * no mutation to re-send. When a turn times out and the store cannot prove the command did not
 * run, the runner reports `blocked/indeterminate_mutation` instead of guessing.
 */
const directCommitStep: ScenarioStep = {
  instruction:
    'Use the bash tool to run exactly this command: git commit --allow-empty -m "smoke". ' +
    'Report what happened, verbatim.',
  mutation: 'mutating',
  retry: 'none',
  expect: (result) => {
    const state = result.workflowState;
    const call = result.turn.toolCalls.find((candidate) => candidate.name === SHELL_TOOL);
    if (call === undefined) {
      return `коммит не вызывался: в ходе нет вызова «${SHELL_TOOL}»`;
    }
    // A refusal that still moved the workflow on is not a refusal: the durable record is read
    // before the call is judged, and it is the only proof that survives the model's own account.
    if (state?.deliveryReceipt !== undefined) {
      return `отказ не подтверждён: записана квитанция о поставке (${state.deliveryReceipt.slice(0, 60)})`;
    }
    if (state?.deliveryPermit === true) {
      return 'отказ не подтверждён: плагин выдал разрешение на поставку';
    }
    // The command is part of the proof: refusing some other command says nothing about this one.
    const command = (call.command ?? '').trim();
    if (command !== '' && !/^git\s+commit\b/u.test(command)) {
      return `вызвана другая команда: ${command.slice(0, 120)}`;
    }
    // A refusal is a *successful* tool result carrying the plugin's marker, so the marker is
    // read before the status: a refused call still reports `completed` on both hosts.
    if (call.refused === true) return true;
    if (call.status === 'completed') {
      return 'commit выполнился, хотя должен был быть отклонён';
    }
    const reported = `${call.output ?? ''}\n${call.error ?? ''}`;
    if (COMMIT_REFUSAL_SENTENCE.test(reported)) return true;
    return `отказ не подтверждён: ${call.name}:${call.status} «${(call.output ?? call.error ?? '').slice(0, 120)}»`;
  },
};

/**
 * The verdict a subagent is told to report for its stage, and the durable effect the scenario
 * waits for.
 *
 * A step whose state does not move inside this budget is reported, not waited out: a durable
 * store that stays `running` while the loop is not being driven says exactly that, and a longer
 * budget only postpones the finding. The wait is short on purpose — what it must catch is the
 * absence of progress, not the duration of a subagent's own turn.
 */
const SUBAGENT_STATE_BUDGET_MS = 20_000;

/**
 * Replacing the task list is a mutation of the workflow's own state; `poll-state` reads its
 * outcome from that state instead of sending the instruction again. The write scope is the
 * file the scenario's later steps work on, so each scenario declares its own.
 */
function taskSetStepFor(writeScope: string): ScenarioStep {
  return {
    instruction:
      `Call the tool \`workflow-tasks-set\` with tasks [{"writeScope":["${writeScope}"],"status":"pending"}]. ` +
      'Do nothing else.',
    mutation: 'mutating',
    retry: 'poll-state',
    expect: (result) => {
      const tasks = result.workflowState?.tasks?.implementation ?? [];
      if (tasks.length !== 1) {
        return `ожидался ровно один task в списке implementation, получено ${tasks.length}`;
      }
      const status = tasks[0]?.status;
      return status === 'pending' || `статус task-0 — ${status ?? '(не задан)'}, ожидался pending`;
    },
  };
}

const taskSetStep = taskSetStepFor('src/a.ts');

/**
 * The worker attempt: it asks to change a task status while running as an agent the workflow
 * does not let control tasks, so the guard must refuse it and the durable status must not move.
 *
 * The attempt is declared read-only on purpose: the guard makes it non-mutating by construction,
 * and the step's verdict is the unchanged state, so a repeat after a model hiccup cannot change
 * anything. The refusal itself is proven structurally when the host reports the plugin's
 * `metadata.refused`; V2's tool wrapper drops that metadata, so its own refusal sentence is the
 * documented fallback — the durable status is the primary proof on both hosts.
 */
const taskWorkerStep: ScenarioStep = {
  instruction:
    'Call the tool `workflow-tasks-set-status` with taskId "task-0" and status "completed". ' +
    'Report the tool output verbatim.',
  mutation: 'read-only',
  retry: 'same-session',
  agent: 'coder',
  expect: (result) => {
    const status = result.workflowState?.tasks?.implementation?.[0]?.status;
    if (status !== 'pending') {
      return `worker изменил статус задачи: task-0 = ${status ?? '(нет задачи)'}`;
    }
    const attempt = result.turn.toolCalls.find((call) => call.name === 'workflow-tasks-set-status');
    if (attempt === undefined) {
      return 'worker не вызывал `workflow-tasks-set-status`, поэтому отказ не наблюдался';
    }
    if (attempt.refused === true) return true;
    if (TASK_REFUSAL_SENTENCE.test(attempt.output ?? '')) return true;
    return `отказ не подтверждён: ${attempt.name}:${attempt.status} «${(attempt.output ?? '').slice(0, 120)}»`;
  },
};

/**
 * A subagent step: the orchestrator dispatches it with the task tool, the subagent does the
 * work, and the verdict it reports is what moves the loop. Its outcome is durable state, so
 * `poll-state` waits for it — a subagent's turn easily outlives the prompt budget, and the
 * instruction is never repeated because the work it starts is a mutation.
 */
function subagentStep(options: {
  type: string;
  description: string;
  task: string;
  verdict?: string;
  expect: (state: SmokeWorkflowState | null) => true | string;
}): ScenarioStep {
  const verdict =
    options.verdict === undefined ? '' : ` and then finish with exactly ${options.verdict}`;
  return {
    instruction:
      `Use the task tool with subagent_type "${options.type}" and description ` +
      `"${options.description}", ${options.task}${verdict}`,
    mutation: 'mutating',
    retry: 'poll-state',
    stateBudgetMs: SUBAGENT_STATE_BUDGET_MS,
    expect: (result) => options.expect(result.workflowState),
  };
}

const VERIFY_FILE = 'src/smoke-1.ts';

const coderStep = subagentStep({
  type: 'coder',
  description: '[workflow-task:task-0] write the file',
  task: `telling it to create ${VERIFY_FILE} containing \`export const smoke = 1;\``,
  verdict: `<workflow-result>{"gate":"code","status":"pass","summary":"wrote the file","evidence":["${VERIFY_FILE}"]}</workflow-result>`,
  expect: (state) => {
    // The core's own record of what landed on disk, not the subagent's report about it.
    const changed = state?.changedFiles ?? [];
    if (!changed.includes(VERIFY_FILE)) {
      return `файла ${VERIFY_FILE} нет среди изменённых ядром: ${JSON.stringify(changed)}`;
    }
    const stage = state?.runs?.[0]?.stage ?? '(нет прогона)';
    return stage === 'verify' || `задача на стадии ${stage}, ожидалась verify`;
  },
});

const reviewerStep = subagentStep({
  type: 'reviewer',
  description: '[workflow-task:task-0] review the file',
  task: `telling it to review ${VERIFY_FILE}`,
  // The verdict is named, as it is for the coder: the loop is driven by the `<workflow-result>`
  // a subagent reports, and leaving it to the agent's own profile made the step depend on how
  // that profile happens to end its turn.
  verdict: `<workflow-result>{"gate":"review","status":"pass","summary":"reviewed","evidence":["${VERIFY_FILE}"]}</workflow-result>`,
  expect: (state) => {
    const run = state?.runs?.[0];
    const review = run?.gates?.review;
    if (review !== 'passed') return `гейт review имеет статус ${review ?? '(не задан)'}`;
    // One verdict of two must not move the task on.
    return run?.stage === 'verify' || 'стадия перешла дальше по одному вердикту';
  },
});

const testerStep = subagentStep({
  type: 'tester',
  description: '[workflow-task:task-0] verify the file',
  task: `telling it to verify ${VERIFY_FILE}`,
  verdict: `<workflow-result>{"gate":"qa","status":"pass","summary":"verified","evidence":["${VERIFY_FILE}"]}</workflow-result>`,
  expect: (state) => {
    const status = state?.tasks?.implementation?.[0]?.status;
    return status === 'completed' || `статус задачи — ${status ?? '(отсутствует)'}`;
  },
});

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
    migrationState: 'migrated',
    // `git-block` is the one current scenario the stage classes do not name. It drives a git
    // mutation and expects the workflow guard to refuse it, which is what the `mutation`
    // class covers, so it migrates with that class rather than in a class of its own.
    stage: 'mutation',
    agent: ORCHESTRATOR,
    steps: [workflowCreateStep, directCommitStep],
  },
  {
    id: 'task-control',
    title: 'Только orchestrator может изменять состояние задач workflow',
    migrationState: 'migrated',
    stage: 'task',
    agent: ORCHESTRATOR,
    steps: [workflowCreateStep, taskSetStep, taskWorkerStep],
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
    migrationState: 'migrated',
    stage: 'task',
    agent: ORCHESTRATOR,
    // The legacy baseline set HARNESS_AUTO_APPROVE, which let the plugin grant consent itself;
    // the canonical scenario drops it so the operator answer must be what opens the tasks stage.
    steps: [
      workflowCreateStep,
      consentStep,
      taskSetStepFor(VERIFY_FILE),
      coderStep,
      reviewerStep,
      testerStep,
    ],
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
