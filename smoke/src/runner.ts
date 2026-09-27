/**
 * One runner for every canonical scenario, whichever host kind is behind it.
 *
 * It owns step order, the retry policy, cleanup and the scenario result. Durable workflow
 * state is read only through `SmokeHost`, and a finished prompt is never a pass: every step
 * is judged by its own expectation against structured evidence.
 */

import type { SmokeHost } from './host/facade.ts';
import { buildPromptResult, isPluginTool } from './host/transport.ts';
import { assertScenarioResultInvariant, createBlockedResult } from './host/types.ts';
import type {
  BlockedReason,
  FailureKind,
  MigratedScenarioDefinition,
  NormalizedToolCall,
  PromptResult,
  ScenarioResult,
  ScenarioStep,
  SmokeSession,
  SmokeWorkflowState,
} from './host/types.ts';
import { logEvent } from './log.ts';

export interface RunnerOptions {
  /** Attempts a step that declared `read-only` + `same-session` may take. Defaults to one. */
  attempts?: number;
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
 * never sent twice into the same stateful session, whatever the step declared. The remaining
 * strategies (`poll-state`, `new-session`) are not implemented in this stage, and a registry
 * that declares one is rejected before any host starts.
 */
function plannedAttempts(step: ScenarioStep, options: RunnerOptions): number {
  if (step.retry !== 'same-session' || step.mutation !== 'read-only') return 1;
  return Math.max(1, options.attempts ?? 1);
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

async function runStep(
  host: SmokeHost,
  session: SmokeSession,
  definition: MigratedScenarioDefinition,
  step: ScenarioStep,
  options: RunnerOptions
): Promise<StepOutcome> {
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
    if (process.env.HOST_SMOKE_DEBUG) {
      logEvent(`  step[${attempt}]: ${step.instruction.slice(0, 90)}`, 'blue', 'step.start', {
        attempt,
        mutation: step.mutation,
        retry: step.retry,
      });
    }
    made = attempt;
    try {
      last = await host.runPrompt(session, {
        text: step.instruction,
        ...(definition.agent === undefined ? {} : { agent: definition.agent }),
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
    const verdict = step.expect(last);
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
    if (process.env.HOST_SMOKE_DEBUG) {
      logEvent(`  wait: ${detail.slice(0, 180)}`, 'yellow', 'step.state', { attempt });
    }
  }

  // None of these attempts says what the instruction did, so the durable state is observed
  // first: an expectation the persisted state already satisfies is the outcome, and nothing
  // about it is guessed.
  const running = timedOut || thrown !== undefined;
  const unprovable = running || failedTurn;
  const reading = await readDurable(host, session);
  let freshRead = '';
  if (step.mutation === 'mutating' && unprovable && reading.outcome === 'present') {
    const fromState = observationFromState(last, thrown ?? '', reading.state);
    if (step.expect(fromState) === true) {
      return {
        ok: true,
        attempts: made,
        evidence: '',
        last: fromState,
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
    freshRead = 'свежее чтение состояния ожидание не подтвердило';
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
  last: PromptResult | undefined
): string {
  return [
    `шагов: ${definition.steps.length}, попыток: ${attempts}`,
    `turn=${last?.turn.status ?? 'unknown'}`,
    describeToolCalls(last?.turn.toolCalls ?? []),
    `stage=${last?.workflowState?.currentStage ?? '(none)'}`,
  ].join('; ');
}

function describeToolCalls(toolCalls: NormalizedToolCall[]): string {
  if (toolCalls.length === 0) return 'tools=[]';
  return `tools=[${toolCalls
    .map((call) => {
      const command = call.command === undefined ? '' : ` «${call.command.slice(0, 60)}»`;
      return `${call.name}:${call.status}${command}`;
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
  let attempts = 0;
  let session: SmokeSession | undefined;
  let last: PromptResult | undefined;
  const notes: string[] = [];
  const observed: NormalizedToolCall[] = [];

  try {
    session = await host.createSession(definition.id);
    for (const step of definition.steps) {
      const outcome = await runStep(host, session, definition, step, options);
      attempts += outcome.attempts;
      if (outcome.last !== undefined) last = outcome.last;
      observed.push(...outcome.observed);
      if (outcome.ok && outcome.note !== undefined) notes.push(outcome.note);
      const durationMs = Date.now() - startedAt;
      logEvent(
        outcome.ok ? '  PASS' : outcome.blockedReason ? '  BLOCKED' : '  FAIL',
        outcome.ok ? 'green' : outcome.blockedReason ? 'yellow' : 'red',
        'step.result',
        {
          scenario: definition.id,
          attempts: outcome.attempts,
          ...(outcome.ok || outcome.blockedReason !== undefined
            ? {}
            : { failureKind: failureKindOf(observed) }),
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
      evidence: [passEvidence(definition, attempts, last), ...notes].join('\n'),
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
