#!/usr/bin/env bun
/**
 * host-smoke — drives the built plugin through a real `opencode serve` host.
 *
 * Every assertion is checked against what the host and the plugin actually did: the
 * workflow session the plugin persisted and the tool results the host recorded. Nothing
 * here reaches into the plugin, so a scenario passing here is evidence that the mechanism
 * works in production rather than that a unit test agrees with itself.
 *
 * One canonical registry serves both host kinds, and one runner runs it:
 *
 *   bun run smoke/src/run.ts                    # parity run: canonical scenarios on V1 and V2
 *   bun run smoke/src/run.ts plugin-loads create# only these canonical scenarios, both kinds
 *   HOST_SMOKE_OPENCODE_VERSION=v1 bun run smoke/src/run.ts create   # single-host check
 *
 * Environment: HOST_SMOKE_MODEL, HOST_SMOKE_PLUGIN, HOST_SMOKE_ATTEMPTS,
 *      HOST_SMOKE_OPENCODE_VERSION.
 */
import { join } from 'node:path';

import {
  REPO_ROOT,
  attemptsFromEnv,
  buildPlugin,
  hostVersionFromEnv,
  stopAllHosts,
} from './harness.ts';
import {
  LiveEnvironmentUnavailableError,
  bootstrapHost,
  scenarioHostOptions,
  startSmokeHost,
  type RunningSmokeHost,
} from './host/facade.ts';
import type { HostKind, ParityReportEntry, ScenarioResult } from './host/types.ts';
import { log } from './log.ts';
import {
  aggregateExitCode,
  assertSingleEntryPerScenario,
  notRunEntry,
  parityEntryFromPartialResults,
  parityEntryFromResults,
  singleHostParityEntry,
} from './parity.ts';
import {
  canonicalScenarios,
  findScenario,
  parityMatrix,
  validateScenarioDefinitions,
  type CanonicalScenario,
} from './registry.ts';
import {
  formatDuration,
  renderParityReport,
  writeSmokeReport,
  type HostBinding,
  type ReportMode,
} from './report.ts';
import { runScenario, statePollBudgetMs, DEFAULT_POLL_INTERVAL_MS } from './runner.ts';

const REPORT_PATH = join(REPO_ROOT, 'docs/plans/host-smoke.md');

let shutdownPromise: Promise<void> | undefined;

function installSignalHandlers(): void {
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      if (shutdownPromise) return;
      shutdownPromise = (async () => {
        await stopAllHosts();
        process.exit(exitCode);
      })();
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The project inputs every canonical scenario receives, on both host kinds alike. */
async function commonSmokeFiles(): Promise<Record<string, string>> {
  return {
    'commit-task.ts': await Bun.file(join(REPO_ROOT, 'scripts/commit-task.ts')).text(),
    'plan.md': '# Smoke plan\n\nAdd one file under src/.\n',
  };
}

function resolvePlugin(): string {
  const provided = process.env.HOST_SMOKE_PLUGIN;
  if (provided !== undefined && provided !== '') return provided;
  try {
    const plugin = buildPlugin();
    process.env.HOST_SMOKE_PLUGIN = plugin;
    return plugin;
  } catch (error) {
    log('error', `сборка плагина не удалась: ${messageOf(error)}`, { type: 'error' });
    return process.exit(2);
  }
}

function selectScenarios(requested: string[]): CanonicalScenario[] {
  if (requested.length === 0) return canonicalScenarios;
  const unknown: string[] = [];
  const selected: CanonicalScenario[] = [];
  for (const id of requested) {
    const scenario = findScenario(id);
    if (scenario === undefined) unknown.push(id);
    else selected.push(scenario);
  }
  if (unknown.length > 0) {
    log(
      'error',
      `Сценарий не найден: ${unknown.join(', ')}. Известные: ${canonicalScenarios
        .map((scenario) => scenario.id)
        .join(', ')}`,
      { type: 'error' }
    );
    process.exit(2);
  }
  return selected;
}

/** Record one scenario result under its host kind for the parity table. */
function recordResult(
  into: Map<string, Partial<Record<HostKind, ScenarioResult>>>,
  scenarioId: string,
  result: ScenarioResult
): void {
  const hosted = into.get(scenarioId) ?? {};
  hosted[result.hostKind] = result;
  into.set(scenarioId, hosted);
}

interface RunLedger {
  results: ScenarioResult[];
  /** One parity row per selected canonical scenario; the report's single source. */
  parityEntries: ParityReportEntry[];
  byScenario: Map<string, Partial<Record<HostKind, ScenarioResult>>>;
}

/**
 * Run every selected migrated scenario through every requested host kind.
 *
 * A host kind whose live environment is missing is reported once and skipped: its scenarios
 * become `not-run` with `live-environment-unavailable` instead of failing for a reason the
 * scenario cannot control.
 */
async function runCanonical(
  selected: CanonicalScenario[],
  kinds: HostKind[],
  models: Map<HostKind, string>,
  unavailable: Map<HostKind, string>,
  commonFiles: Record<string, string>,
  ledger: RunLedger
): Promise<void> {
  const attempts = attemptsFromEnv();
  const polls = {
    pollBudgetMs: statePollBudgetMs(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
  for (const kind of kinds) {
    const model = models.get(kind);
    if (model === undefined) continue;
    for (const scenario of selected) {
      if (scenario.migrationState !== 'migrated') continue;
      log('info', `▶ ${scenario.id} (${kind}) …`, {
        type: 'scenario.start',
        color: 'cyan',
        fields: { scenario: scenario.id, hostKind: kind },
      });
      let host: RunningSmokeHost | undefined;
      try {
        host = await startSmokeHost(scenarioHostOptions(scenario, kind, model, commonFiles));
        const result = await runScenario(host, scenario, { attempts, ...polls });
        ledger.results.push(result);
        recordResult(ledger.byScenario, scenario.id, result);
        log(
          result.status === 'pass' ? 'info' : result.status === 'blocked' ? 'warn' : 'error',
          result.status === 'pass'
            ? `ПРОЙДЕНО (попыток: ${result.attempts}, ${formatDuration(result.durationMs)})`
            : `${result.status === 'blocked' ? 'ЗАБЛОКИРОВАНО' : 'ОШИБКА'} (${formatDuration(result.durationMs)})`,
          {
            type: 'scenario.result',
            color:
              result.status === 'pass' ? 'green' : result.status === 'blocked' ? 'yellow' : 'red',
            fields: {
              scenario: scenario.id,
              hostKind: kind,
              status: result.status,
              attempts: result.attempts,
              durationMs: result.durationMs,
            },
          }
        );
        {
          log(
            result.status === 'pass' ? 'debug' : 'error',
            result.evidence
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n'),
            { type: 'scenario.evidence', color: result.status === 'pass' ? 'gray' : 'red' }
          );
        }
        if (result.status !== 'pass') {
          log(
            'error',
            host
              .logs()
              .split('\n')
              .filter((line) => /session-guard|consent|DIAG|workflow/i.test(line))
              .slice(-25)
              .join('\n'),
            { type: 'scenario.host-log', color: 'red' }
          );
        }
      } catch (error) {
        if (!(error instanceof LiveEnvironmentUnavailableError)) throw error;
        unavailable.set(kind, messageOf(error));
        log('error', `хост ${kind} недоступен: ${messageOf(error)}`, {
          type: 'host.unavailable',
          color: 'red',
          fields: { kind },
        });
        break;
      } finally {
        await host?.stop();
      }
    }
  }
}

/**
 * One parity row for every selected canonical scenario, whatever happened to it.
 *
 * A scenario is never left as scattered results: the side that ran keeps its result in the
 * row, the side that did not is a `not-run` with its closed reason, and a run that measured a
 * single host kind records `limited` instead of dropping the row. The `not-run` rows of this
 * list are also the exit code's input, so no second list can disagree with the report.
 */
function collectParityEntries(
  selected: CanonicalScenario[],
  kinds: HostKind[],
  mode: ReportMode,
  unavailable: Map<HostKind, string>,
  ledger: RunLedger
): void {
  for (const scenario of selected) {
    if (scenario.migrationState !== 'migrated') {
      ledger.parityEntries.push(
        notRunEntry(
          scenario.id,
          'pending-migration',
          `${scenario.stage}: сценарий ещё не мигрирован`
        )
      );
      continue;
    }
    const hosted = ledger.byScenario.get(scenario.id) ?? {};
    const missing = kinds.filter((kind) => hosted[kind] === undefined);
    const why = (kind: HostKind): string =>
      `хост ${kind}: ${unavailable.get(kind) ?? 'сценарий не запускался'}`;

    if (mode === 'parity') {
      if (missing.length === 0) {
        ledger.parityEntries.push(parityEntryFromResults(scenario.id, hosted.v1!, hosted.v2!));
        continue;
      }
      ledger.parityEntries.push(
        parityEntryFromPartialResults(
          scenario.id,
          hosted,
          'live-environment-unavailable',
          missing.map(why).join('; ')
        )
      );
      continue;
    }

    // A single-host run measures no parity; the selected kind either ran or never came up.
    const ran = kinds.map((kind) => hosted[kind]).filter((result) => result !== undefined);
    ledger.parityEntries.push(
      ran.length === 1 && ran[0] !== undefined
        ? singleHostParityEntry(scenario.id, ran[0])
        : notRunEntry(scenario.id, 'live-environment-unavailable', kinds.map(why).join('; '))
    );
  }
}

async function main(): Promise<void> {
  installSignalHandlers();
  const startedAt = Date.now();
  const requested = process.argv.slice(2);

  const selected = selectScenarios(requested);
  const problems = validateScenarioDefinitions(selected);
  if (problems.length > 0) {
    for (const problem of problems) {
      log('error', `[ERROR] ${problem.scenarioId}: ${problem.problem}`, {
        type: 'registry.problem',
      });
    }
    log('error', 'canonical registry не готов к запуску', { type: 'error' });
    process.exit(2);
  }

  const versionEnv = process.env.HOST_SMOKE_OPENCODE_VERSION?.trim();
  const mode: ReportMode = versionEnv === undefined || versionEnv === '' ? 'parity' : 'single-host';
  const kinds: HostKind[] = mode === 'parity' ? ['v1', 'v2'] : [hostVersionFromEnv(versionEnv)];

  const plugin = resolvePlugin();
  const models = new Map<HostKind, string>();
  const unavailable = new Map<HostKind, string>();
  const hosts: HostBinding[] = [];
  for (const kind of kinds) {
    try {
      const bootstrap = await bootstrapHost(kind);
      models.set(kind, bootstrap.model);
      hosts.push({ kind, binary: bootstrap.binary });
    } catch (error) {
      // Only an unavailable live environment is a not-run condition; a broken harness or
      // plugin must end the run instead of hiding behind `not-run`.
      if (!(error instanceof LiveEnvironmentUnavailableError)) throw error;
      unavailable.set(kind, messageOf(error));
      log('error', `хост ${kind} недоступен до запуска сценариев: ${messageOf(error)}`, {
        type: 'host.unavailable',
        color: 'red',
        fields: { kind },
      });
    }
  }

  const ledger: RunLedger = {
    results: [],
    parityEntries: [],
    byScenario: new Map(),
  };
  await runCanonical(selected, kinds, models, unavailable, await commonSmokeFiles(), ledger);
  collectParityEntries(selected, kinds, mode, unavailable, ledger);
  assertSingleEntryPerScenario(ledger.parityEntries);

  // The exit code reads the same rows the report prints, so the two cannot disagree.
  const notRun = ledger.parityEntries.filter((entry) => entry.notRunReason !== undefined);
  const exitCode = aggregateExitCode({
    results: ledger.results,
    notRun,
  });
  const model = [...models.values()][0] ?? '(модель не разрешена)';
  const report = renderParityReport({
    mode,
    model,
    plugin,
    hosts,
    results: ledger.results,
    entries: ledger.parityEntries,
    matrix: parityMatrix(selected),
    exitCode,
    durationMs: Date.now() - startedAt,
  });
  await writeSmokeReport(REPORT_PATH, report);

  const passed = ledger.results.filter((result) => result.status === 'pass').length;
  log(
    exitCode === 0 ? 'info' : 'error',
    `\n${passed}/${ledger.results.length} пройдено (код выхода ${exitCode}) — отчёт записан в ${REPORT_PATH}`,
    {
      type: 'run.summary',
      color: exitCode === 0 ? 'green' : 'red',
      fields: {
        passed,
        total: ledger.results.length,
        exitCode,
        reportPath: REPORT_PATH,
        notRun: notRun.map((entry) => `${entry.scenarioId}:${entry.notRunReason}`),
      },
    }
  );
  process.exit(exitCode);
}

try {
  await main();
} catch (error) {
  log('error', `фатальная ошибка запуска: ${messageOf(error)}`, { type: 'error' });
  await stopAllHosts();
  process.exit(2);
}
