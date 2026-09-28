/**
 * The one host contract the scenarios and the runner depend on, and the single place where
 * the V1/V2 transport strategy is chosen.
 *
 * Above this file nothing knows an endpoint, a generated client, a basic-auth header, a
 * question or a form. Below it, two strategies hide exactly those differences.
 */

import {
  defaultModel,
  ensureOpencodeBinary,
  startHost,
  EnvironmentUnavailableError,
  type Host,
  type HostOptions,
} from '../harness.ts';
import { pluginObservationFrom } from './transport.ts';
import type { HostTransport } from './transport.ts';
import { createLegacyHttpTransport } from './v1-transport.ts';
import { createSessionClientTransport } from './v2-transport.ts';
import type {
  HostKind,
  PromptInput,
  PromptResult,
  ScenarioDefinition,
  SmokeSession,
  SmokeWorkflowState,
} from './types.ts';

/**
 * Предел на весь ход, один для обоих хостов.
 *
 * Две минуты, а не минута: первый ход на холодном V1-хосте законно длится дольше минуты, и
 * минутный предел резал бы нормальную работу (это выяснилось живым прогоном `no-session`).
 * Патология, ради которой предел и введён, была 1123 s — она ловится и здесь.
 */
const DEFAULT_TURN_BUDGET_MS = 120_000;

function turnBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HOST_SMOKE_PROMPT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TURN_BUDGET_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TURN_BUDGET_MS;
}

/**
 * Предел на весь ход, а не на отдельный вызов хоста.
 *
 * Клиент V2 ограничивает каждый свой вызов (prompt, wait, обход форм), но ход состоит из
 * нескольких, и залипший вызов между ними оставлял шаг ждать минуты: в живом прогоне один ход
 * шёл 1123 s при объявленном бюджете 60 s. Поэтому бюджет применяется здесь, поверх стратегии,
 * и действует одинаково для обоих хостов.
 *
 * Истёкший ход — это `timed-out` ход, а не выдуманная ошибка: runner уже умеет читать исход
 * такого хода из состояния и никогда не повторяет мутацию, чтобы выяснить его.
 */
async function promptWithinBudget(
  work: Promise<PromptResult>,
  budgetMs: number
): Promise<PromptResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<PromptResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              turn: {
                status: 'timed-out',
                transcript: `ход хоста не завершился за бюджет промпта (${budgetMs} мс)`,
                parts: [],
                toolCalls: [],
              },
              workflowState: null,
              pluginEvidence: pluginObservationFrom([], 'timed-out'),
            }),
          budgetMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Profile every canonical scenario runs under unless it names its own. */
export const DEFAULT_PROFILE = 'smoke';

/** The contract a scenario drives, whichever host kind is behind it. */
export interface SmokeHost {
  readonly kind: HostKind;
  /**
   * Проект прогона. Сценарии поставки доказывают мутацию сменой git HEAD, а это наблюдение
   * рабочего каталога, а не хоста: он одинаков для обоих host kinds.
   */
  readonly workDir: string;
  createSession(title: string): Promise<SmokeSession>;
  runPrompt(session: SmokeSession, input: PromptInput): Promise<PromptResult>;
  /**
   * The durable state the plugin persisted for this session.
   *
   * `null` means one thing only — the store holds no session — which is what proves a mutating
   * instruction applied nothing. A store that exists but cannot be read, or that does not hold
   * a workflow session, rejects instead: an unvouched-for payload is never evidence of absence.
   */
  readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>;
  closeSession(session: SmokeSession): Promise<void>;
}

/** A running host: the scenario contract plus the lifecycle the CLI owns. */
export interface RunningSmokeHost extends SmokeHost {
  readonly model: string;
  logs(): string;
  stop(): Promise<void>;
}

/** What the facade needs from the started process to expose a running host. */
export interface SmokeHostRuntime {
  workDir: string;
  model: string;
  logs: () => string;
  stop: () => Promise<void>;
}

/**
 * The live environment a scenario needs is not there, before that scenario ran at all: a
 * missing host binary, a model the operator's configuration cannot name, or a host that
 * never started listening.
 *
 * The CLI reports this as `not-run` with `live-environment-unavailable` for the affected
 * host kind instead of blaming the scenario for it.
 */
export class LiveEnvironmentUnavailableError extends Error {
  readonly hostKind: HostKind;
  readonly reason: unknown;

  constructor(hostKind: HostKind, reason: unknown) {
    super(
      `[ERROR] живая среда хоста ${hostKind} недоступна: ${
        reason instanceof Error ? reason.message : String(reason)
      }`
    );
    this.name = 'LiveEnvironmentUnavailableError';
    this.hostKind = hostKind;
    this.reason = reason;
  }
}

/** Everything a host kind needs from the scenario's canonical metadata. */
export interface SmokeHostOptions {
  kind: HostKind;
  model: string;
  profile: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
  git?: boolean;
  /** Agent every prompt of this host runs as. */
  agent?: string;
  /** Budget one V2 prompt may take; V1 has no client-side budget of its own. */
  promptTimeoutMs?: number;
}

/**
 * Canonical scenario metadata as the harness input. One scenario definition produces the
 * same project for both host kinds; only the plugin config syntax inside `startHost`
 * differs, and that is not visible here.
 */
export function scenarioHostOptions(
  definition: ScenarioDefinition,
  kind: HostKind,
  model: string,
  commonFiles: Record<string, string> = {}
): SmokeHostOptions {
  return {
    kind,
    model,
    profile: definition.profile ?? DEFAULT_PROFILE,
    env: { ...definition.env },
    files: { ...commonFiles, ...definition.files },
    git: definition.git ?? true,
    ...(definition.agent === undefined ? {} : { agent: definition.agent }),
  };
}

/** The single branch on host version: one facade, two internal strategies. */
export function createTransport(host: Host, options: SmokeHostOptions): HostTransport {
  if (options.kind === 'v2') {
    return createSessionClientTransport(host, {
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.promptTimeoutMs === undefined
        ? {}
        : { promptTimeoutMs: options.promptTimeoutMs }),
    });
  }
  return createLegacyHttpTransport(host, {
    model: options.model,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
}

/**
 * The one place a bootstrap error becomes a not-run condition or stays fatal.
 *
 * Only the environment failing to provide a host is `live-environment-unavailable` (the CLI
 * reports it as `not-run`, exit `5`). Every other bootstrap error — configuration written
 * wrongly, a missing profile fixture, a failed plugin build — means the harness or the
 * plugin is broken, so it propagates and ends the run fatally (exit `2`).
 */
export function classifyBootstrapError(kind: HostKind, error: unknown): Error {
  if (error instanceof EnvironmentUnavailableError) {
    return new LiveEnvironmentUnavailableError(kind, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** The binary and model of one host kind. Both are live-environment facts, not scenario ones. */
export async function bootstrapHost(
  kind: HostKind,
  requestedModel?: string
): Promise<{ kind: HostKind; binary: string; model: string }> {
  try {
    const binary = ensureOpencodeBinary(kind);
    return { kind, binary, model: requestedModel ?? (await defaultModel(binary)) };
  } catch (error) {
    throw classifyBootstrapError(kind, error);
  }
}

/**
 * Bind one transport to the shared contract.
 *
 * The facade owns two invariants, so no transport repeats them:
 *
 * - a session belongs to the host that created it (a session from another host kind — a
 *   compatibility bridge artefact or a test fake — fails loudly instead of being driven
 *   through the wrong strategy);
 * - a prompt result carries verified host operation, because the facade is the layer that
 *   started a real host: a strategy that cannot confirm it is a defect, not evidence.
 */
export function createSmokeHost(
  kind: HostKind,
  transport: HostTransport,
  runtime: SmokeHostRuntime
): RunningSmokeHost {
  const owned = (session: SmokeSession): void => {
    if (session.hostKind !== kind) {
      throw new Error(
        `[ERROR] хост ${kind} получил сессию хоста ${session.hostKind} («${session.id}»): ` +
          'сессию обслуживает только создавший её хост'
      );
    }
  };

  return {
    kind,
    workDir: runtime.workDir,
    model: runtime.model,
    logs: runtime.logs,
    createSession: (title) => transport.createSession(title),
    runPrompt: async (session, input) => {
      owned(session);
      const result = await promptWithinBudget(transport.prompt(session, input), turnBudgetMs());
      // Ход, прерванный бюджетом, ничего не наблюдал по построению: он не доказательство
      // работы хоста и не повод его требовать.
      if (result.turn.status === 'timed-out' && result.pluginEvidence.hostOperation === 'unknown') {
        return result;
      }
      // The facade is the layer that actually owns a started host, so a strategy that drove
      // one must say so. A transport that cannot claim host operation is a defect here, not
      // evidence a scenario should have to distrust.
      if (result.pluginEvidence.hostOperation !== 'real-host') {
        throw new Error(
          '[ERROR] transport strategy did not confirm host operation: ' +
            `hostOperation=${result.pluginEvidence.hostOperation}`
        );
      }
      return result;
    },
    readWorkflowState: async (session) => {
      owned(session);
      return transport.readWorkflowState(session);
    },
    closeSession: async (session) => {
      owned(session);
      await transport.removeSession(session);
    },
    stop: runtime.stop,
  };
}

/** Start one isolated host and expose it through the shared contract. */
export async function startSmokeHost(options: SmokeHostOptions): Promise<RunningSmokeHost> {
  const harnessOptions: HostOptions = {
    model: options.model,
    version: options.kind,
    profile: options.profile,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.git === undefined ? {} : { git: options.git }),
  };
  let host: Host;
  try {
    host = await startHost(harnessOptions);
  } catch (error) {
    throw classifyBootstrapError(options.kind, error);
  }
  return createSmokeHost(options.kind, createTransport(host, options), {
    workDir: host.workDir,
    model: options.model,
    logs: () => host.logs(),
    stop: () => host.stop(),
  });
}
