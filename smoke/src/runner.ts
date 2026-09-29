/**
 * One runner for every canonical scenario, whichever host kind is behind it.
 *
 * It owns step order, the retry policy, cleanup and the scenario result. Durable workflow
 * state is read only through `SmokeHost`, and a finished prompt is never a pass: every step
 * is judged by its own expectation against structured evidence.
 */

import { execFileSync } from 'node:child_process';

import { writeWorkflowSession } from './harness.ts';
import { log } from './log.ts';
import type { SmokeHost } from './host/facade.ts';
import { buildPromptResult, isPluginTool } from './host/transport.ts';
import { assertScenarioResultInvariant, createBlockedResult } from './host/types.ts';
import type {
  BlockedReason,
  FailureKind,
  MigratedScenarioDefinition,
  NormalizedInteraction,
  NormalizedToolCall,
  PromptResult,
  ScenarioResult,
  ScenarioStep,
  SmokeSession,
  SmokeWorkflowState,
  StepWorkspace,
} from './host/types.ts';

export interface RunnerOptions {
  /** Attempts a step that declared `read-only` + `same-session` may take. Defaults to one. */
  attempts?: number;
  /** How long `poll-state` may keep reading the durable store for a step that declares none. */
  pollBudgetMs?: number;
  /**
   * An upper bound applied to every step's wait, including one that declared its own budget.
   * A subagent step asks for minutes; an operator who wants a hard ceiling on a run, or a test
   * that must finish quickly, sets this instead of lowering the step's own declaration.
   */
  maxPollBudgetMs?: number;
  /** How often `poll-state` reads it. */
  pollIntervalMs?: number;
}

export const DEFAULT_POLL_BUDGET_MS = 5_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * How long a `poll-state` step may wait for the durable outcome, from the environment. An
 * unusable value falls back to the default rather than waiting forever on a typo.
 */
export function statePollBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HOST_SMOKE_STATE_POLL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_POLL_BUDGET_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_BUDGET_MS;
}

interface StepOutcome {
  ok: boolean;
  attempts: number;
  /** The unmet expectation, or the observed limitation the runner blocked on. */
  evidence: string;
  blockedReason?: BlockedReason;
  /** Last turn observed, kept so a failure names what the host actually showed. */
  last?: PromptResult;
  /** Every tool call the step's turns reported, for the failure class. */
  observed: NormalizedToolCall[];
  /** Something about a passing step the report should still say out loud. */
  note?: string;
}

/**
 * What reading the durable store established.
 *
 * The three outcomes are deliberately not collapsed: `absent` is the only one that proves a
 * mutating instruction applied nothing, and a store that exists but cannot be vouched for is
 * `unreadable` — never silently the same as nothing being there.
 */
type DurableReading =
  | { outcome: 'absent' }
  | { outcome: 'present'; state: SmokeWorkflowState }
  | { outcome: 'unreadable'; reason: string };

async function readDurable(host: SmokeHost, session: SmokeSession): Promise<DurableReading> {
  try {
    const state = await host.readWorkflowState(session);
    return state === null ? { outcome: 'absent' } : { outcome: 'present', state };
  } catch (error) {
    return { outcome: 'unreadable', reason: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many times one step may be prompted.
 *
 * Only a read-only step that declared `same-session` may repeat: a mutating instruction is
 * never sent twice into the same stateful session, whatever the step declared. `poll-state`
 * never re-prompts at all — it reads the durable outcome instead (see `pollOutcome`) — and a
 * registry that declares `new-session` is rejected before any host starts.
 */
function plannedAttempts(step: ScenarioStep, options: RunnerOptions): number {
  if (step.retry !== 'same-session' || step.mutation !== 'read-only') return 1;
  return Math.max(1, options.attempts ?? 1);
}

/**
 * Wait for a mutating step's durable outcome without ever repeating its instruction.
 *
 * `poll-state` is the recovery the contract prescribes when the operation may already have
 * happened: the prompt is sent once, and only the plugin's own store is read until its deadline.
 * Returns the observation that satisfied the expectation, or nothing if it never did.
 */
/** The effective wait for one step: its own declaration, the run's default, and the run's cap. */
function stateBudgetFor(step: ScenarioStep, options: RunnerOptions): number {
  const declared = step.stateBudgetMs ?? options.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  return Math.min(declared, options.maxPollBudgetMs ?? declared);
}

interface PollOutcome {
  /** The observation that satisfied the step, when one did. */
  observation?: PromptResult;
  /** One line per read: what the store said while the step waited, and what was still missing. */
  rounds: string[];
}

/** A one-line picture of the durable state a step was waiting on. */
function summarizeState(state: SmokeWorkflowState | null): string {
  if (state === null) return '(нет состояния)';
  const tasks = (state.tasks?.implementation ?? [])
    .map((task) => `${task.id}=${task.status}`)
    .join(',');
  const runs = (state.runs ?? [])
    .map((run) => `${run.taskId}/${run.stage}:${run.status}`)
    .join(',');
  return `stage=${state.currentStage ?? '(нет)'} tasks=[${tasks}] runs=[${runs}]`;
}

async function pollOutcome(
  host: SmokeHost,
  session: SmokeSession,
  step: ScenarioStep,
  last: PromptResult | undefined,
  options: RunnerOptions,
  workspace: () => StepWorkspace
): Promise<PollOutcome> {
  // A step whose instruction dispatches a subagent declares its own budget, the run's applies
  // only when it does not, and the run may cap both. Every read is recorded: a step that fails
  // has to say what the store looked like while it waited, otherwise a stall and a slow turn
  // read the same from the outside.
  const budget = stateBudgetFor(step, options);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, budget);
  const interval = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const rounds: string[] = [];
  for (;;) {
    const elapsed = `+${Math.round((Date.now() - startedAt) / 1000)}s`;
    const reading = await readDurable(host, session);
    if (reading.outcome === 'present') {
      const observation = observationFromState(last, '', reading.state);
      const verdict = evaluateExpectation(step, observation, workspace);
      if (verdict === true) return { observation, rounds };
      rounds.push(`${elapsed} ${summarizeState(reading.state)} → ${verdict}`);
    } else {
      rounds.push(`${elapsed} состояние ${reading.outcome}`);
    }
    if (Date.now() >= deadline) return { rounds };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * git HEAD проекта прогона, или пустая строка, когда git его не знает.
 *
 * Наблюдение нужно сценариям поставки: мутация доказывается сменой HEAD, а не отчётом модели.
 * Отсутствие HEAD — не ошибка runner'а: сценарий без git просто не может им пользоваться.
 */
function gitHead(workDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/** Первые восемь символов git HEAD: достаточно, чтобы сравнить два наблюдения. */
function shortHead(head: string): string {
  return head === '' ? '(none)' : head.slice(0, 8);
}

/** How long a step has been running, in seconds with one decimal. */
function secondsSince(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function durableLabel(reading: DurableReading): string {
  if (reading.outcome === 'unreadable') return `unknown (${reading.reason})`;
  return reading.outcome === 'absent' ? 'none' : 'applied';
}

/**
 * Whether the outcome of this step's instruction cannot be proven.
 *
 * - `unreadable` — the store exists but cannot be vouched for (unreadable, or it does not
 *   hold a workflow session): nothing about the instruction is proven, not even that it
 *   applied nothing;
 * - `running` — a turn that never came back, or a prompt that threw: the operation may still
 *   be in flight, so not even an absent store proves it did not land;
 * - `failedTurn` — a turn that answered with an error while the store holds something: it may
 *   have died in the middle of its mutation, and that state cannot be attributed to this step.
 *
 * Anything else is provable: a finished turn with an absent store proves the instruction
 * applied no durable mutation, so the step fails like any other unmet expectation.
 */
function unprovenMutation(
  step: ScenarioStep,
  reading: DurableReading,
  attempt: { running: boolean; failedTurn: boolean }
): BlockedReason | undefined {
  if (step.mutation !== 'mutating') return undefined;
  if (reading.outcome === 'unreadable') return 'indeterminate_mutation';
  if (attempt.running) return 'indeterminate_mutation';
  return attempt.failedTurn && reading.outcome === 'present' ? 'indeterminate_mutation' : undefined;
}

/**
 * The observation a step is judged by when its turn did not answer, built from the durable
 * state the plugin actually persisted — the same evidence a returned turn would carry.
 *
 * The origin is `'unknown'` on purpose: this builder is not a transport strategy, so it does
 * not claim host operation on its own; the durable read underneath it went through the facade.
 */
function observationFromState(
  last: PromptResult | undefined,
  error: string,
  state: SmokeWorkflowState
): PromptResult {
  if (last !== undefined) return { ...last, workflowState: state };
  return buildPromptResult({ status: 'failed', parts: [], error }, state, 'unknown');
}

/** Keep malformed transport results inside the scenario failure evidence. */
function evaluateExpectation(
  step: ScenarioStep,
  result: PromptResult | null | undefined,
  workspace: () => StepWorkspace
): true | string {
  try {
    return step.expect(result as PromptResult, workspace());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `предикат шага не обработал результат хоста: ${reason}`;
  }
}

async function runStep(
  host: SmokeHost,
  session: SmokeSession,
  definition: MigratedScenarioDefinition,
  step: ScenarioStep,
  options: RunnerOptions
): Promise<StepOutcome> {
  const stepStartedAt = Date.now();
  // Подготовка — мутация, поэтому выполняется один раз за шаг, а не на каждую попытку.
  if (step.prepare !== undefined) {
    await step.prepare({
      workDir: host.workDir,
      sessionId: session.id,
      seed: (state: unknown) => writeWorkflowSession(host, session.id, state),
    });
  }
  const headBefore = gitHead(host.workDir);
  const workspace = (): StepWorkspace => ({
    workDir: host.workDir,
    headBefore,
    headAfter: gitHead(host.workDir),
  });
  const planned = plannedAttempts(step, options);
  let made = 0;
  let detail = '';
  let timedOut = false;
  let failedTurn = false;
  let thrown: string | undefined;
  let last: PromptResult | undefined;
  const observed: NormalizedToolCall[] = [];
  // A repeat that later succeeds must not erase what the earlier attempts did: the report has to
  // say that the step needed them and why.
  const unmet: string[] = [];

  for (let attempt = 1; attempt <= planned; attempt += 1) {
    log('debug', `  step[${attempt}]: ${step.instruction}`, {
      type: 'step.start',
      color: 'blue',
      fields: { attempt, mutation: step.mutation, retry: step.retry },
    });
    made = attempt;
    const agent = step.agent ?? definition.agent;
    try {
      last = await host.runPrompt(session, {
        text: step.instruction,
        ...(agent === undefined ? {} : { agent }),
        ...(step.turnBudgetMs === undefined ? {} : { turnBudgetMs: step.turnBudgetMs }),
      });
    } catch (error) {
      // The prompt died before it answered. Whether it mutated anything is read back below
      // instead of guessed, and no mutation is repeated to find out.
      thrown = messageOf(error);
      break;
    }
    if (last.turn.status === 'timed-out') timedOut = true;
    if (last.turn.status === 'failed') failedTurn = true;
    observed.push(...last.turn.toolCalls);
    const verdict = evaluateExpectation(step, last, workspace);
    if (verdict === true) {
      return {
        ok: true,
        attempts: made,
        evidence: '',
        last,
        observed,
        ...(unmet.length === 0 ? {} : { note: unmet.join('; ') }),
      };
    }
    detail = verdict;
    if (attempt < planned) unmet.push(`попытка ${attempt}: ${detail}`.slice(0, 200));
    log('debug', `  wait: ${detail.slice(0, 180)}`, {
      type: 'step.state',
      color: 'yellow',
      fields: { attempt },
    });
  }

  // Neither a timed-out turn nor a thrown prompt says what the instruction did, so the
  // durable state is observed first: an expectation the persisted state already satisfies is
  // the outcome, and nothing about it is guessed.
  const running = timedOut || thrown !== undefined;
  const unprovable = running || failedTurn;
  let reading = await readDurable(host, session);
  let freshRead = '';
  const satisfied =
    step.mutation === 'mutating' && unprovable && reading.outcome === 'present'
      ? observationFromState(last, thrown ?? '', reading.state)
      : undefined;
  if (satisfied !== undefined && evaluateExpectation(step, satisfied, workspace) === true) {
    return {
      ok: true,
      attempts: made,
      evidence: '',
      last: satisfied,
      observed,
      note: [
        ...unmet,
        thrown !== undefined
          ? 'промпт не вернулся, исход подтверждён сохранённым состоянием'
          : timedOut
            ? 'ход хоста не завершился за бюджет промпта, исход подтверждён сохранённым состоянием'
            : 'ход хоста вернулся с ошибкой, исход подтверждён сохранённым состоянием',
      ].join('; '),
    };
  }
  if (step.mutation === 'mutating' && unprovable && reading.outcome === 'present') {
    freshRead = 'свежее чтение состояния ожидание не подтвердило';
  }

  // `poll-state` is the last chance for a mutating step: the instruction stays sent once, and
  // only the durable store is read until its deadline.
  let pollRounds: string[] = [];
  if (step.retry === 'poll-state') {
    const polled = await pollOutcome(host, session, step, last, options, workspace);
    pollRounds = polled.rounds;
    if (polled.observation !== undefined) {
      return {
        ok: true,
        attempts: made,
        evidence: '',
        last: polled.observation,
        observed,
        note: [
          ...unmet,
          `исход подтверждён состоянием после ожидания (retry=poll-state, повтор промпта не отправлялся)`,
          `опросов: ${polled.rounds.length}`,
        ].join('; '),
      };
    }
    freshRead = `${freshRead === '' ? '' : `${freshRead}; `}poll-state не подтвердил ожидание за ${stateBudgetFor(
      step,
      options
    )} мс`;
    reading = await readDurable(host, session);
    if (reading.outcome === 'present') {
      const finalObservation = observationFromState(last, '', reading.state);
      if (evaluateExpectation(step, finalObservation, workspace) === true) {
        return {
          ok: true,
          attempts: made,
          evidence: '',
          last: finalObservation,
          observed,
          note: [
            ...unmet,
            'исход подтверждён финальным чтением состояния после границы ожидания',
          ].join('; '),
        };
      }
    }
  }

  const blockedReason = unprovenMutation(step, reading, { running, failedTurn });
  const evidence = [
    thrown !== undefined
      ? `промпт шага не выполнился: ${thrown}`
      : `ожидание шага не выполнено за ${made} попыт.: ${detail}`,
    freshRead,
    // Which side failed is part of the evidence: a model that never completed a plugin call
    // is not a host defect, and the transcript alone would leave that to guesswork.
    ...(blockedReason === undefined ? [failureClassLine(failureKindOf(observed), observed)] : []),
    `шаг занял: ${secondsSince(stepStartedAt)} s`,
    ...(pollRounds.length === 0 ? [] : [`ожидание шага: ${pollRounds.slice(-4).join('; ')}`]),
    describeInteractions(last?.interactions),
    `hostKind=${host.kind} mutation=${step.mutation} retry=${step.retry}`,
    `durableMutation=${durableLabel(reading)}`,
    timedOut ? 'ход хоста не завершился за бюджет промпта' : '',
    reading.outcome === 'present' ? `state: ${JSON.stringify(reading.state).slice(0, 400)}` : '',
    last === undefined ? '' : `транскрипт: ${last.turn.transcript.slice(0, 600)}`,
  ]
    .filter((entry) => entry !== '')
    .join('\n');
  return {
    ok: false,
    attempts: made,
    evidence,
    observed,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(last === undefined ? {} : { last }),
  };
}

/** What a passing scenario actually proved, read back from the evidence it collected. */
function passEvidence(
  definition: MigratedScenarioDefinition,
  attempts: number,
  last: PromptResult | undefined,
  headBefore: string,
  headAfter: string
): string {
  return [
    `шагов: ${definition.steps.length}, попыток: ${attempts}`,
    `turn=${last?.turn.status ?? 'unknown'}`,
    describeToolCalls(last?.turn.toolCalls ?? []),
    describeInteractions(last?.interactions),
    `stage=${last?.workflowState?.currentStage ?? '(none)'}`,
    `delivery=${deliveryEvidence(last?.workflowState)}`,
    `head=${shortHead(headBefore)}→${shortHead(headAfter)}`,
    `files=${JSON.stringify(last?.workflowState?.changedFiles ?? [])}`,
  ].join('; ');
}

/**
 * The durable delivery facts a pass is read back with.
 *
 * A scenario that proves a refusal has to say that no permission to deliver and no receipt were
 * recorded, not merely that the model said so: the store is the only proof that survives the
 * model's own account.
 */
function deliveryEvidence(state: SmokeWorkflowState | null | undefined): string {
  const receipt = state?.deliveryReceipt;
  if (receipt !== undefined) return `receipt:${receipt.slice(0, 40)}`;
  return state?.deliveryPermit === true ? 'permit-granted' : 'none';
}

/** The operator interactions a turn answered, which is what proves consent went through. */
function describeInteractions(interactions: NormalizedInteraction[] | undefined): string {
  if (interactions === undefined || interactions.length === 0) return 'interactions=[]';
  return `interactions=[${interactions
    .map(
      (entry) =>
        `${entry.kind}:${entry.isConsent ? 'consent:' : ''}${entry.decision} «${entry.label}»`
    )
    .join(', ')}]`;
}

function describeToolCalls(toolCalls: NormalizedToolCall[]): string {
  if (toolCalls.length === 0) return 'tools=[]';
  return `tools=[${toolCalls
    .map((call) => {
      const command = call.command === undefined ? '' : ` «${call.command.slice(0, 60)}»`;
      const refused = call.refused === true ? ':refused' : '';
      return `${call.name}:${call.status}${refused}${command}`;
    })
    .join(', ')}]`;
}

/**
 * Which kind of failure the evidence supports.
 *
 * A completed plugin tool proves the plugin ran, so a still-unmet expectation is observable
 * host/plugin behaviour. Without a completed plugin call the plugin's behaviour was never
 * observed, and the run must be repeated instead of being read as a host defect.
 */
function failureKindOf(toolCalls: NormalizedToolCall[]): FailureKind {
  const pluginCalls = toolCalls.filter((call) => isPluginTool(call.name));
  if (pluginCalls.some((call) => call.status === 'completed')) return 'host';
  return pluginCalls.length > 0 ? 'unknown' : 'model';
}

function failureClassLine(kind: FailureKind, toolCalls: NormalizedToolCall[]): string {
  const tools = describeToolCalls(toolCalls);
  if (kind === 'host') {
    return `класс отказа: наблюдаемое поведение host/plugin — вызов плагина завершился, ожидание не выполнено (${tools})`;
  }
  if (kind === 'unknown') {
    return `класс отказа: не определено — инструмент плагина вызывался, но ни один вызов не завершился (${tools}); решает транскрипт`;
  }
  return `класс отказа: инструкцию не выполнила модель — ни одного завершённого вызова плагина (${tools})`;
}

/**
 * Run one migrated scenario in its own session and always close that session, whether the
 * scenario passed, failed, blocked or threw.
 */
export async function runScenario(
  host: SmokeHost,
  definition: MigratedScenarioDefinition,
  options: RunnerOptions = {}
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  // Наблюдение рабочего каталога до первой инструкции: сценарий поставки доказывает мутацию
  // сменой git HEAD, и сравнить её можно только с тем, что было в начале прогона.
  const scenarioHeadBefore = gitHead(host.workDir);
  let attempts = 0;
  let session: SmokeSession | undefined;
  let last: PromptResult | undefined;
  const notes: string[] = [];
  const observed: NormalizedToolCall[] = [];

  try {
    session = await host.createSession(definition.id);
    for (const step of definition.steps) {
      const stepStartedAt = Date.now();
      const outcome = await runStep(host, session, definition, step, options);
      // Длительность каждого шага — часть отчёта: без неё «долго» в pipeline не отличить от
      // «залипло», а именно этот вопрос и возникает на длинных сценариях.
      const stepSeconds = ((Date.now() - stepStartedAt) / 1000).toFixed(1);
      attempts += outcome.attempts;
      if (outcome.last !== undefined) last = outcome.last;
      observed.push(...outcome.observed);
      if (outcome.ok) {
        notes.push(
          outcome.note === undefined
            ? `шаг: ${stepSeconds} s`
            : `${outcome.note}; шаг: ${stepSeconds} s`
        );
      } else if (outcome.note !== undefined) {
        notes.push(outcome.note);
      }
      const durationMs = Date.now() - startedAt;
      log(
        outcome.ok ? 'info' : outcome.blockedReason ? 'warn' : 'error',
        outcome.ok
          ? `  PASS (${stepSeconds} s)`
          : outcome.blockedReason
            ? `  BLOCKED (${stepSeconds} s)`
            : `  FAIL (${stepSeconds} s)`,
        {
          type: 'step.result',
          color: outcome.ok ? 'green' : outcome.blockedReason ? 'yellow' : 'red',
          fields: {
            scenario: definition.id,
            attempts: outcome.attempts,
            ...(outcome.ok || outcome.blockedReason !== undefined
              ? {}
              : { failureKind: failureKindOf(observed) }),
          },
        }
      );
      if (outcome.ok) continue;
      const result: ScenarioResult =
        outcome.blockedReason === undefined
          ? {
              id: definition.id,
              title: definition.title,
              hostKind: host.kind,
              status: 'fail',
              attempts,
              durationMs,
              evidence: outcome.evidence,
              failureKind: failureKindOf(observed),
            }
          : createBlockedResult({
              id: definition.id,
              title: definition.title,
              hostKind: host.kind,
              attempts,
              durationMs,
              evidence: outcome.evidence,
              blockedReason: outcome.blockedReason,
            });
      assertScenarioResultInvariant(result);
      return result;
    }

    const result: ScenarioResult = {
      id: definition.id,
      title: definition.title,
      hostKind: host.kind,
      status: 'pass',
      attempts,
      durationMs: Date.now() - startedAt,
      evidence: [
        passEvidence(definition, attempts, last, scenarioHeadBefore, gitHead(host.workDir)),
        ...notes,
      ].join('\n'),
    };
    assertScenarioResultInvariant(result);
    return result;
  } catch (error) {
    // An infrastructure exception, a plugin error or an unmet assertion is a failure, never
    // a blocked result. Whatever the host already showed is kept as evidence.
    const reading = session === undefined ? undefined : await readDurable(host, session);
    const result: ScenarioResult = {
      id: definition.id,
      title: definition.title,
      hostKind: host.kind,
      status: 'fail',
      attempts,
      durationMs: Date.now() - startedAt,
      evidence: [
        `необработанная ошибка сценария: ${messageOf(error)}`,
        `класс отказа: не обработано — поведение host/plugin или harness не подтверждено (${describeToolCalls(observed)})`,
        last === undefined ? '' : `транскрипт: ${last.turn.transcript.slice(0, 600)}`,
        reading === undefined
          ? ''
          : `durableMutation=${durableLabel(reading)}${
              reading.outcome === 'present'
                ? ` state: ${JSON.stringify(reading.state).slice(0, 300)}`
                : ''
            }`,
      ]
        .filter((entry) => entry !== '')
        .join('\n'),
      failureKind: 'unknown',
    };
    assertScenarioResultInvariant(result);
    return result;
  } finally {
    if (session !== undefined) await host.closeSession(session).catch(() => undefined);
  }
}
