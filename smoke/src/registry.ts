/**
 * The one canonical scenario registry.
 *
 * A single list serves both host kinds: the runner picks a host kind, never a scenario list.
 * Migration state is registry metadata and is deliberately separate from runnable status —
 * a `pending` scenario keeps its canonical id, title and inputs for the parity report, and
 * produces no scenario result at all.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SHELL_TOOL } from './host/transport.ts';
import type {
  HostKind,
  NormalizedToolCall,
  PromptResult,
  ScenarioDefinition,
  ScenarioStep,
  SmokeWorkflowState,
  StepWorkspace,
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
  /** Длинный шаг pipeline объявляет свои пределы вместо общих. */
  turnBudgetMs?: number;
  stateBudgetMs?: number;
  /** Ожидание видит и состояние, и рабочий каталог: файл проверяется на диске. */
  expect: (state: SmokeWorkflowState | null, workspace?: StepWorkspace) => true | string;
}): ScenarioStep {
  const verdict =
    options.verdict === undefined ? '' : ` and then finish with exactly ${options.verdict}`;
  return {
    instruction:
      `Use the task tool with subagent_type "${options.type}" and description ` +
      `"${options.description}", ${options.task}${verdict}`,
    mutation: 'mutating',
    retry: 'poll-state',
    stateBudgetMs: options.stateBudgetMs ?? SUBAGENT_STATE_BUDGET_MS,
    ...(options.turnBudgetMs === undefined ? {} : { turnBudgetMs: options.turnBudgetMs }),
    expect: (result, workspace) => options.expect(result.workflowState, workspace),
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
/**
 * Как отчиталась guarded-команда: структурированный отказ, факт выполнения или текст отказа.
 *
 * Порядок обязателен. Отказ — это успешный результат вызова с маркером плагина, поэтому маркер
 * читается раньше статуса; выполнившаяся команда — это `fail` независимо от того, что сказала
 * модель; текст отказа остаётся документированным fallback для хоста, который не сообщил ни
 * маркера, ни ошибки (V2 снимает `metadata` у своих обёрток).
 */
function shellCommandOutcome(
  result: PromptResult,
  expected: { command: RegExp; refusal: RegExp; what: string }
): true | string {
  const call = result.turn.toolCalls.find((candidate) => candidate.name === SHELL_TOOL);
  if (call === undefined) {
    return `${expected.what} не вызывалась: в ходе нет вызова «${SHELL_TOOL}»`;
  }
  const command = (call.command ?? '').trim();
  if (command !== '' && !expected.command.test(command)) {
    return `вызвана другая команда: ${command.slice(0, 120)}`;
  }
  if (call.refused === true) return true;
  if (call.status === 'completed') {
    return `${expected.what} выполнилась, хотя должна была быть отклонена`;
  }
  const reported = `${call.output ?? ''}\n${call.error ?? ''}`;
  if (expected.refusal.test(reported)) return true;
  return `отказ не подтверждён: ${call.name}:${call.status} «${(call.output ?? call.error ?? '').slice(0, 120)}»`;
}

/** Короткая запись наблюдения HEAD для сообщения об отказе. */
function headNote(head: string): string {
  return head === '' ? '(нет HEAD)' : head.slice(0, 12);
}

/** Файл, который сценарии поставки готовят под разрешение. */
const COMMIT_FILE = 'src/smoke-1.ts';

/** Файл, которого workflow не видел: коммит с ним не должен получить квитанцию. */
const UNRELATED_FILE = 'unrelated.txt';

/**
 * Согласие под `HARNESS_AUTO_APPROVE`.
 *
 * Сценарии поставки живут с этим env, и он же — условие легитимности коммита: плагин одобряет
 * план сам. Операторского ответа здесь поэтому не бывает, и шаг доказывает применённое согласие
 * тем, что записано в состоянии: durable-ссылка на план и переход стадии.
 */
const autoApprovedConsentStep: ScenarioStep = {
  instruction: CONSENT_INSTRUCTION,
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const state = result.workflowState;
    if (state?.refs?.plan === undefined) return 'план не записан в durable refs';
    const stage = state.currentStage ?? '(не задана)';
    return stage === 'tasks_ready' || `стадия — ${stage}, ожидалась tasks_ready`;
  },
};

/** Список задач на файл поставки: стадия уходит в `execution`. */
const commitTaskSetStep: ScenarioStep = {
  instruction:
    `Call the tool \`workflow-tasks-set\` with tasks [{"writeScope":["${COMMIT_FILE}"],"status":"pending"}]. ` +
    'Do nothing else.',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const stage = result.workflowState?.currentStage ?? '(не задана)';
    return stage === 'execution' || `стадия — ${stage}, ожидалась execution`;
  },
};

/** Работа задачи: файл, который коммит понесёт. */
const commitWriteStep: ScenarioStep = {
  instruction:
    `Use the write tool to create ${COMMIT_FILE} with the content "export const smoke = 1;\n". ` +
    'Do nothing else.',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const changed = result.workflowState?.changedFiles ?? [];
    return (
      changed.includes(COMMIT_FILE) ||
      `файла ${COMMIT_FILE} нет среди изменённых ядром: ${JSON.stringify(changed)}`
    );
  },
};

/** Задача выполнена: без этого прогон не закроется, а коммит не станет легитимным. */
const commitTaskDoneStep: ScenarioStep = {
  instruction:
    'Call the tool `workflow-tasks-set-status` with taskId "task-0" and status "completed". ' +
    'Do nothing else.',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const status = result.workflowState?.tasks?.implementation?.[0]?.status;
    return status === 'completed' || `task-0: статус ${status ?? '(отсутствует)'}`;
  },
};

/** Вердикт review закрывает гейт стадии валидации. */
const commitReviewStep = subagentStep({
  type: 'reviewer',
  description: 'review the work',
  task: `telling it to review ${COMMIT_FILE}`,
  verdict: `<workflow-result>{"gate":"review","status":"pass","summary":"reviewed","evidence":["${COMMIT_FILE}"]}</workflow-result>`,
  expect: (state) => {
    const gate = state?.stageGates?.review;
    return gate === 'passed' || `гейт review стадии имеет статус ${gate ?? '(не задан)'}`;
  },
});

/** Вердикт qa закрывает второй гейт и переводит сессию на стадию коммита. */
const commitVerifyStep = subagentStep({
  type: 'tester',
  description: 'verify the work',
  task: `telling it to verify ${COMMIT_FILE}`,
  verdict: `<workflow-result>{"gate":"qa","status":"pass","summary":"verified","evidence":["${COMMIT_FILE}"]}</workflow-result>`,
  expect: (state) => {
    const stage = state?.currentStage ?? '(не задана)';
    return stage === 'commit' || `стадия — ${stage}, ожидалась commit после обоих вердиктов`;
  },
});

/**
 * Ранняя поставка: гейты не закрыты, поэтому `commit-task` обязан отказать.
 *
 * Доказательство — durable сторона: HEAD не сдвинулся, разрешения и квитанции нет. Слова модели
 * здесь не значат ничего, а текст отказа читается только когда хост не сообщил структуры.
 */
const earlyCommitStep: ScenarioStep = {
  instruction:
    'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: too early". ' +
    'Report what happened, verbatim.',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result, workspace) => {
    const state = result.workflowState;
    if (state?.deliveryReceipt !== undefined) {
      return `отказ не подтверждён: записана квитанция о поставке (${state.deliveryReceipt.slice(0, 60)})`;
    }
    if (state?.deliveryPermit === true) {
      return 'отказ не подтверждён: плагин выдал разрешение на поставку';
    }
    const before = workspace?.headBefore ?? '';
    const after = workspace?.headAfter ?? '';
    if (before !== '' && after !== '' && after !== before) {
      return `отказ не подтверждён: HEAD переместился с ${headNote(before)} на ${headNote(after)}`;
    }
    return shellCommandOutcome(result, {
      command: /bun\s+run\s+commit-task/u,
      refusal: COMMIT_REFUSAL_SENTENCE,
      what: 'ранняя поставка',
    });
  },
};

/** Легитимная поставка: HEAD перемещается, квитанция фиксирует новый коммит. */
const deliverCommitStep: ScenarioStep = {
  instruction:
    'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: deliver". ' +
    'Report the output verbatim.',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result, workspace) => {
    const state = result.workflowState;
    const before = workspace?.headBefore ?? '';
    const after = workspace?.headAfter ?? '';
    if (after === '' || before === after) {
      return `поставка не состоялась: HEAD остался ${headNote(after)}`;
    }
    const receipt = state?.deliveryReceipt;
    if (receipt === undefined) {
      return `квитанция о поставке не записана (разрешение: ${state?.deliveryPermit === true ? 'есть' : 'нет'})`;
    }
    return (
      receipt === after ||
      `квитанция ${receipt.slice(0, 12)} не соответствует HEAD ${headNote(after)}`
    );
  },
};

/**
 * Поставка с посторонним файлом: HEAD перемещается, но квитанции быть не должно, а выданное
 * разрешение обязано перестать действовать. Это ожидаемый mismatch, а не успешная поставка.
 */
const mismatchCommitStep: ScenarioStep = {
  instruction:
    'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: sweep". ' +
    'Report the output verbatim.',
  mutation: 'mutating',
  retry: 'poll-state',
  prepare: async ({ workDir }) => {
    // Файл, которого workflow не видел: коммит понесёт больше, чем допускает разрешение.
    await writeFile(join(workDir, UNRELATED_FILE), 'not part of the work\n', 'utf-8');
  },
  expect: (result, workspace) => {
    const state = result.workflowState;
    if (state?.deliveryReceipt !== undefined) {
      return `коммит постороннего файла получил квитанцию (${state.deliveryReceipt.slice(0, 60)})`;
    }
    if (state?.deliveryPermit === true) {
      return 'устаревшее разрешение осталось на месте';
    }
    const before = workspace?.headBefore ?? '';
    const after = workspace?.headAfter ?? '';
    if (before !== '' && after !== '' && after === before) {
      return 'коммит не произошёл, поэтому проверить было нечего';
    }
    return true;
  },
};

/**
 * Пределы длинного шага pipeline.
 *
 * Субагент, который собирает, тестирует или выкатывает, законно идёт минутами, поэтому общий
 * предел хода завершал бы pipeline преждевременно. Пределы остаются ограниченными: исход шага
 * читается из состояния до бюджета, а недоказуемая мутация становится `blocked`.
 */
const PIPELINE_TURN_BUDGET_MS = 240_000;
const PIPELINE_STATE_BUDGET_MS = 180_000;

/**
 * Шагам, чей результат — переход состояния (создание сессии, согласие), длинный ход не нужен:
 * подтверждение приходит из состояния, а брошенный ход — это чистое ожидание. V2 как раз на
 * таких шагах и жёг полный бюджет.
 */
const PIPELINE_SHORT_TURN_BUDGET_MS = 90_000;

/** Файл, который pipeline создаёт на стадии checkout и потом проверяет. */
const PIPELINE_FILE = 'src/ci-demo.ts';

const pipelineBudgets = {
  turnBudgetMs: PIPELINE_TURN_BUDGET_MS,
  stateBudgetMs: PIPELINE_STATE_BUDGET_MS,
} as const;

/**
 * Создание сессии pipeline-профиля. Стадия не называется: у профиля `cicd` своя первая стадия,
 * и сценарий доказывает, что сессия под управлением, а не что она называется так же, как в
 * smoke-профиле.
 */
const cicdCreateStep: ScenarioStep = {
  instruction: 'Call the tool `workflow-create` with schemaId "cicd". Do nothing else.',
  mutation: 'mutating',
  retry: 'poll-state',
  turnBudgetMs: PIPELINE_SHORT_TURN_BUDGET_MS,
  stateBudgetMs: PIPELINE_STATE_BUDGET_MS,
  expect: (result) => {
    const state = result.workflowState;
    if (state === null) return 'сессия workflow не сохранена';
    const stage = state.currentStage;
    return stage !== undefined ? true : 'стадия сессии не записана';
  },
};

/** Согласие под `HARNESS_AUTO_APPROVE`: переход открывает стадия `checkout`. */
const cicdPlanConsentStep: ScenarioStep = {
  turnBudgetMs: PIPELINE_SHORT_TURN_BUDGET_MS,
  stateBudgetMs: PIPELINE_STATE_BUDGET_MS,
  instruction: CONSENT_INSTRUCTION,
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const stage = result.workflowState?.currentStage ?? '(не задана)';
    return stage === 'checkout' || `стадия — ${stage}, ожидалась checkout`;
  },
};

/**
 * Setup: субагент создаёт файл и закрывает `checkout_done`. Файл проверяется раньше гейта —
 * агент, закрывший гейт без записи, иначе прошёл бы здесь и сорвал pipeline двумя шагами позже.
 */
const cicdSetupStep = subagentStep({
  type: 'setup',
  description: '[workflow-task:checkout] prepare the project',
  task: `telling it to create ${PIPELINE_FILE} containing \`export const appVersion = "1.0.0";\``,
  verdict: `<workflow-result>{"gate":"checkout_done","status":"pass","summary":"created source file","evidence":["${PIPELINE_FILE}"]}</workflow-result>`,
  ...pipelineBudgets,
  expect: (state, workspace) => {
    // Файл проверяется на диске, а не по `changedFiles`: диспатчи pipeline описываются как
    // `[workflow-task:checkout]`, а admission ведёт запись изменений только для
    // `[workflow-task:task-N]`. Так же проверял и legacy, и это и есть «фактический файл».
    const file = join(workspace?.workDir ?? '', PIPELINE_FILE);
    if (!existsSync(file)) {
      return `файла ${PIPELINE_FILE} нет в проекте прогона`;
    }
    const gate = state?.stageGates?.checkout_done;
    return gate === 'passed' || `гейт checkout_done имеет статус ${gate ?? '(не задан)'}`;
  },
});

const cicdBuildStep = subagentStep({
  type: 'builder',
  description: '[workflow-task:build] build the project',
  task: `telling it to verify ${PIPELINE_FILE} compiles correctly`,
  verdict: `<workflow-result>{"gate":"build_done","status":"pass","summary":"build successful","evidence":["${PIPELINE_FILE}"]}</workflow-result>`,
  ...pipelineBudgets,
  expect: (state) => {
    const stage = state?.currentStage ?? '(не задана)';
    return stage === 'test' || `стадия — ${stage}, ожидалась test`;
  },
});

/**
 * Список тестовых задач. Без `writeScope`: тестировщик сообщает, а не записывает, а цикл без
 * задач не диспетчеризует ничего — каждый вызов был бы отклонён.
 */
const cicdTestSuiteStep: ScenarioStep = {
  instruction:
    'Call the tool `workflow-tasks-set` with listKey "test_suite" and tasks ' +
    '[{"status":"pending"}]. Do nothing else.',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const tasks = result.workflowState?.tasks?.test_suite ?? [];
    return tasks.length === 1 || `список test_suite: ${JSON.stringify(tasks)}`;
  },
};

/**
 * Одна задача проходит обе вложенные стадии: unit, затем integration. Доказательство того, что
 * unit пройдена, — текущее положение задачи, а не значение гейта: перемещение очищает гейты,
 * по которым выносилось суждение.
 */
const cicdUnitStep = subagentStep({
  type: 'tester',
  description: '[workflow-task:task-0] unit test',
  task: `telling it to run unit tests on ${PIPELINE_FILE}`,
  verdict: `<workflow-result>{"gate":"unit","status":"pass","summary":"unit tests passed","evidence":["${PIPELINE_FILE}"]}</workflow-result>`,
  ...pipelineBudgets,
  expect: (state) => {
    const stage = state?.runs?.[0]?.stage ?? '(нет запуска)';
    return stage === 'integration' || `задача находится на стадии ${stage}`;
  },
});

const cicdIntegrationStep = subagentStep({
  type: 'tester',
  description: '[workflow-task:task-0] integration test',
  task: `telling it to verify ${PIPELINE_FILE} works with the environment`,
  verdict: `<workflow-result>{"gate":"integration","status":"pass","summary":"integration tests passed","evidence":["${PIPELINE_FILE}"]}</workflow-result>`,
  ...pipelineBudgets,
  expect: (state) => {
    const status = state?.tasks?.test_suite?.[0]?.status;
    return status === 'completed' || `статус тестовой задачи: ${status ?? '(отсутствует)'}`;
  },
});

const cicdDeployStep = subagentStep({
  type: 'deployer',
  description: '[workflow-task:deploy] deploy the build',
  task: 'telling it to register the deployment of version 1.0.0',
  verdict:
    '<workflow-result>{"gate":"deploy_done","status":"pass","summary":"deploy successful","evidence":["version=1.0.0"]}</workflow-result>',
  ...pipelineBudgets,
  expect: (state) => {
    const gate = state?.stageGates?.deploy_done;
    return gate === 'passed' || `гейт deploy_done имеет статус ${gate ?? '(не задан)'}`;
  },
});

/**
 * Согласие на `deploy`: ребро `deploy → smoke` объявляет его, поэтому переход закрыт без
 * выданного согласия. Доказательство — durable-запись approvals, а не ответ оператора.
 */
const cicdDeployConsentStep: ScenarioStep = {
  turnBudgetMs: PIPELINE_SHORT_TURN_BUDGET_MS,
  stateBudgetMs: PIPELINE_STATE_BUDGET_MS,
  instruction:
    'Do this in two tool calls and nothing else. ' +
    'First call `workflow-consent` with files ["plan.md"] and summary "smoke plan" and type "deploy". ' +
    'Then call the `question` tool once, passing as the question text the ENTIRE ' +
    '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
    'character for character, with options labelled "grant" and "decline".',
  mutation: 'mutating',
  retry: 'poll-state',
  expect: (result) => {
    const state = result.workflowState;
    const granted = (state?.approvals ?? []).some(
      (approval) => approval.type === 'deploy' && approval.status === 'granted'
    );
    if (!granted) return 'согласие deploy так и не было предоставлено';
    const stage = state?.currentStage ?? '(не задана)';
    return stage === 'smoke' || `стадия — ${stage}, ожидалась smoke`;
  },
};

const cicdSmokeStep = subagentStep({
  type: 'smoke',
  description: '[workflow-task:smoke] smoke test deployment',
  task: 'telling it to verify the deployment',
  verdict:
    '<workflow-result>{"gate":"smoke_result","status":"pass","summary":"smoke tests passed","evidence":["deployment-ok"]}</workflow-result>',
  ...pipelineBudgets,
  expect: (state) => {
    const stage = state?.currentStage ?? '(не задана)';
    return stage === 'done' || `стадия — ${stage}, ожидалась done`;
  },
});

/**
 * Проверка самого механизма вердикта — одним шагом.
 *
 * Сценарий не проходит предыдущие стадии схемы: файл сессии плагина сажается сразу на стадию,
 * объявляющую гейт `review`, и проверяется ровно один durable факт — что вердикт субагента записан
 * гейтом стадии. Так проверяется механизм, а не путь до стадии; путь проверяют другие сценарии.
 */
const verdictProbeStep: ScenarioStep = {
  instruction:
    'Use the task tool with subagent_type "reviewer" and description "report the workflow result", ' +
    'telling it to review the work and then finish with exactly ' +
    '<workflow-result>{"gate":"review","status":"pass","summary":"verdict reached the gate",' +
    '"evidence":["verdict-probe"]}</workflow-result>',
  mutation: 'mutating',
  retry: 'poll-state',
  // Ход с диспатчем вердикта — работа субагента: на V2 он не укладывается в общий предел, а
  // подтвердить исход из состояния нельзя, пока гейт не записан. Поэтому предел свой.
  turnBudgetMs: PIPELINE_TURN_BUDGET_MS,
  stateBudgetMs: PIPELINE_STATE_BUDGET_MS,
  prepare: async ({ sessionId, seed }) => {
    await seed({
      sessionId,
      profileId: 'smoke',
      schemaId: 'smoke',
      currentStage: 'validation',
      status: 'running',
      refs: {},
    });
  },
  expect: (result) => {
    const gate = result.workflowState?.stageGates?.review;
    return gate === 'passed' || `гейт review стадии имеет статус ${gate ?? '(не задан)'}`;
  },
};

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
    migrationState: 'migrated',
    stage: 'mutation',
    agent: ORCHESTRATOR,
    steps: [workflowCreateStep, earlyCommitStep],
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
    migrationState: 'migrated',
    stage: 'mutation',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    agent: ORCHESTRATOR,
    steps: [
      workflowCreateStep,
      autoApprovedConsentStep,
      commitTaskSetStep,
      commitWriteStep,
      commitTaskDoneStep,
      commitReviewStep,
      commitVerifyStep,
      deliverCommitStep,
    ],
  },
  {
    id: 'commit-mismatch',
    title: 'Коммит с посторонним файлом не получает квитанцию',
    migrationState: 'migrated',
    stage: 'mutation',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    agent: ORCHESTRATOR,
    steps: [
      workflowCreateStep,
      autoApprovedConsentStep,
      commitTaskSetStep,
      commitWriteStep,
      commitTaskDoneStep,
      commitReviewStep,
      commitVerifyStep,
      mismatchCommitStep,
    ],
  },
  {
    id: 'cicd-full-cycle',
    title:
      'Полный CI/CD-пайплайн: init → checkout → build → test(unit+integration) → deploy → smoke → done',
    migrationState: 'migrated',
    stage: 'pipeline',
    profile: 'cicd',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    agent: ORCHESTRATOR,
    steps: [
      cicdCreateStep,
      cicdPlanConsentStep,
      cicdSetupStep,
      cicdBuildStep,
      cicdTestSuiteStep,
      cicdUnitStep,
      cicdIntegrationStep,
      cicdDeployStep,
      cicdDeployConsentStep,
      cicdSmokeStep,
    ],
  },
  {
    id: 'workflow-result',
    title: 'Вердикт субагента доезжает до workflow-гейта',
    migrationState: 'migrated',
    stage: 'task',
    agent: ORCHESTRATOR,
    steps: [verdictProbeStep],
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
