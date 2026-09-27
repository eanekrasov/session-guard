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
 *   HOST_SMOKE_BASELINE=1 bun run smoke/src/run.ts plugin-loads      # legacy baseline only
 *
 * Environment: HOST_SMOKE_MODEL, HOST_SMOKE_PLUGIN, HOST_SMOKE_ATTEMPTS,
 *      HOST_SMOKE_PROMPT_TIMEOUT_MS, HOST_SMOKE_OPENCODE_VERSION, HOST_SMOKE_BASELINE.
 */
import { join } from 'node:path';

import {
  REPO_ROOT,
  attemptsFromEnv,
  buildPlugin,
  hostVersionFromEnv,
  startHost,
  stopAllHosts,
  type Host,
} from './harness.ts';
import {
  LiveEnvironmentUnavailableError,
  bootstrapHost,
  scenarioHostOptions,
  startSmokeHost,
  type RunningSmokeHost,
} from './host/facade.ts';
import type { HostKind, ParityReportEntry, ScenarioResult } from './host/types.ts';
import { logEvent } from './log.ts';
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
import { ATTEMPTS, lastStepState } from './scenario-kit.ts';
import { runScenario, statePollBudgetMs, DEFAULT_POLL_INTERVAL_MS } from './runner.ts';
import { scenarios, v2Scenarios } from './scenarios/index.ts';
import { runV2Scenario } from './v2-scenario-kit.ts';

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
    logEvent(`сборка плагина не удалась: ${messageOf(error)}`, 'red', 'error');
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
    logEvent(
      `Сценарий не найден: ${unknown.join(', ')}. Известные: ${canonicalScenarios
        .map((scenario) => scenario.id)
        .join(', ')}`,
      'red',
      'error'
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
  mode: ReportMode,
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
      logEvent(`▶ ${scenario.id} (${kind}) …`, 'cyan', 'scenario.start', {
        scenario: scenario.id,
        hostKind: kind,
      });
      let host: RunningSmokeHost | undefined;
      try {
        host = await startSmokeHost(scenarioHostOptions(scenario, kind, model, commonFiles));
        const result = await runScenario(host, scenario, { attempts, ...polls });
        ledger.results.push(result);
        recordResult(ledger.byScenario, scenario.id, result);
        logEvent(
          result.status === 'pass'
            ? `ПРОЙДЕНО (попыток: ${result.attempts}, ${formatDuration(result.durationMs)})`
            : `${result.status === 'blocked' ? 'ЗАБЛОКИРОВАНО' : 'ОШИБКА'} (${formatDuration(result.durationMs)})`,
          result.status === 'pass' ? 'green' : result.status === 'blocked' ? 'yellow' : 'red',
          'scenario.result',
          {
            scenario: scenario.id,
            hostKind: kind,
            status: result.status,
            attempts: result.attempts,
            durationMs: result.durationMs,
          }
        );
        if (result.status !== 'pass' || process.env.HOST_SMOKE_DEBUG) {
          logEvent(
            result.evidence
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n'),
            result.status === 'pass' ? 'gray' : 'red',
            'scenario.evidence'
          );
        }
        if (result.status !== 'pass' && process.env.HOST_SMOKE_DEBUG) {
          logEvent(
            host
              .logs()
              .split('\n')
              .filter((line) => /session-guard|consent|DIAG|workflow/i.test(line))
              .slice(-25)
              .join('\n'),
            'red',
            'scenario.host-log'
          );
          logEvent(
            `state: ${JSON.stringify(lastStepState()).slice(0, 1200)}`,
            'gray',
            'scenario.state'
          );
        }
      } catch (error) {
        if (!(error instanceof LiveEnvironmentUnavailableError)) throw error;
        unavailable.set(kind, messageOf(error));
        logEvent(`хост ${kind} недоступен: ${messageOf(error)}`, 'red', 'host.unavailable', {
          kind,
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

  if (process.env.HOST_SMOKE_BASELINE === '1') {
    await runBaseline(requested, startedAt);
    return;
  }

  const selected = selectScenarios(requested);
  const problems = validateScenarioDefinitions(selected);
  if (problems.length > 0) {
    for (const problem of problems) {
      logEvent(`[ERROR] ${problem.scenarioId}: ${problem.problem}`, 'red', 'registry.problem');
    }
    logEvent('canonical registry не готов к запуску', 'red', 'error');
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
      logEvent(
        `хост ${kind} недоступен до запуска сценариев: ${messageOf(error)}`,
        'red',
        'host.unavailable',
        {
          kind,
        }
      );
    }
  }

  const ledger: RunLedger = {
    results: [],
    parityEntries: [],
    byScenario: new Map(),
  };
  await runCanonical(selected, kinds, mode, models, unavailable, await commonSmokeFiles(), ledger);
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
  logEvent(
    `\n${passed}/${ledger.results.length} пройдено (код выхода ${exitCode}) — отчёт записан в ${REPORT_PATH}`,
    exitCode === 0 ? 'green' : 'red',
    'run.summary',
    {
      passed,
      total: ledger.results.length,
      exitCode,
      reportPath: REPORT_PATH,
      notRun: notRun.map((entry) => `${entry.scenarioId}:${entry.notRunReason}`),
    }
  );
  process.exit(exitCode);
}

/**
 * Baseline comparison on the legacy runner of the selected host kind.
 *
 * Kept only while migration is incomplete: it compares old behaviour, reports through the
 * same exit-code path, and never feeds the parity report. It disappears with the last
 * migrated scenario, together with the legacy runner it drives.
 */
async function runBaseline(requested: string[], startedAt: number): Promise<void> {
  const kind = hostVersionFromEnv();
  const plugin = resolvePlugin();
  const known =
    kind === 'v1'
      ? scenarios.map((scenario) => ({ id: scenario.id, title: scenario.title }))
      : v2Scenarios.map((scenario) => ({ id: scenario.id, title: scenario.title }));
  const selected =
    requested.length === 0 ? known : known.filter((entry) => requested.includes(entry.id));
  if (selected.length === 0) {
    logEvent(
      `Сценарий ${kind} не найден. Известные: ${known.map((entry) => entry.id).join(', ')}`,
      'red',
      'error'
    );
    process.exit(2);
  }

  let bootstrap: { binary: string; model: string };
  try {
    bootstrap = await bootstrapHost(kind);
  } catch (error) {
    // An unavailable live environment is exit 5 for the baseline too; anything else is a
    // broken harness or plugin and stays fatal.
    if (!(error instanceof LiveEnvironmentUnavailableError)) throw error;
    logEvent(
      `живая среда хоста ${kind} недоступна: ${messageOf(error)}`,
      'red',
      'host.unavailable',
      {
        kind,
      }
    );
    process.exit(5);
  }
  const { model } = bootstrap;
  const files =
    kind === 'v1'
      ? await commonSmokeFiles()
      : { 'plan.md': '# Smoke plan\n\nAdd one file under src/.\n' };

  const results: ScenarioResult[] = [];
  for (const entry of selected) {
    const startedAtScenario = Date.now();
    logEvent(`▶ ${entry.id} (${kind}, baseline) …`, 'cyan', 'scenario.start', {
      scenario: entry.id,
      hostKind: kind,
      baseline: true,
    });
    let host: Host | undefined;
    try {
      if (kind === 'v1') {
        const scenario = scenarios.find((candidate) => candidate.id === entry.id)!;
        host = await startHost({
          model,
          version: 'v1',
          profile: scenario.profile ?? 'smoke',
          env: scenario.env,
          files,
        });
        const outcome = await scenario.run(host, model);
        results.push({
          id: scenario.id,
          title: scenario.title,
          hostKind: 'v1',
          status: outcome.ok ? 'pass' : 'fail',
          attempts: outcome.attempts,
          durationMs: Date.now() - startedAtScenario,
          evidence: outcome.evidence,
        });
      } else {
        const scenario = v2Scenarios.find((candidate) => candidate.id === entry.id)!;
        host = await startHost({ model, version: 'v2', profile: 'smoke', files });
        const outcome = await runV2Scenario(host, scenario, ATTEMPTS);
        results.push({
          id: scenario.id,
          title: scenario.title,
          hostKind: 'v2',
          status: outcome.ok ? 'pass' : 'fail',
          attempts: outcome.attempts,
          durationMs: Date.now() - startedAtScenario,
          evidence: outcome.evidence,
        });
      }
    } catch (error) {
      results.push({
        id: entry.id,
        title: entry.title,
        hostKind: kind,
        status: 'fail',
        attempts: 0,
        durationMs: Date.now() - startedAtScenario,
        evidence: `ошибка baseline-раннера: ${messageOf(error)}`,
      });
    } finally {
      await host?.stop();
    }
    const last = results.at(-1)!;
    logEvent(
      last.status === 'pass'
        ? `ПРОЙДЕНО (попыток: ${last.attempts}, ${formatDuration(last.durationMs)})`
        : `ОШИБКА (${formatDuration(last.durationMs)})`,
      last.status === 'pass' ? 'green' : 'red',
      'scenario.result',
      { scenario: last.id, hostKind: kind, status: last.status, baseline: true }
    );
    if (last.status !== 'pass') {
      logEvent(
        last.evidence
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
        'red',
        'scenario.evidence'
      );
    }
  }

  const exitCode = aggregateExitCode({ results, notRun: [] });
  const report = renderParityReport({
    mode: 'baseline',
    model,
    plugin,
    hosts: [{ kind, binary: bootstrap.binary }],
    results,
    // The legacy runner compares behaviour; it never forms the parity report.
    entries: [],
    matrix: parityMatrix(),
    exitCode,
    durationMs: Date.now() - startedAt,
  });
  await writeSmokeReport(REPORT_PATH, report);
  const passed = results.filter((result) => result.status === 'pass').length;
  logEvent(
    `\n${passed}/${results.length} пройдено (baseline, код выхода ${exitCode}) — отчёт записан в ${REPORT_PATH}`,
    exitCode === 0 ? 'green' : 'red',
    'run.summary',
    { passed, total: results.length, exitCode, baseline: true }
  );
  process.exit(exitCode);
}

try {
  await main();
} catch (error) {
  logEvent(`фатальная ошибка запуска: ${messageOf(error)}`, 'red', 'error');
  await stopAllHosts();
  process.exit(2);
}
