#!/usr/bin/env bun
/**
 * host-smoke — управляет плагином через реальный opencode.
 *
 * Каждое утверждение здесь проверяется на том, что хост и плагин фактически
 * сделали: сессию, сохранённую плагином, и части инструментов, записанные хостом.
 * Ничто не обращается к плагину напрямую, поэтому сценарий, проходящий здесь, —
 * это доказательство, что механизм работает в продакшене, а не что модульный
 * тест согласен сам с собой.
 *
 * Инструментами управляет живая модель, поэтому шаг может упасть из-за того, что
 * модель проигнорировала инструкцию, а не из-за некорректного поведения плагина.
 * Каждый шаг поэтому повторяется, и отчёт записывает, сколько попыток потребовалось:
 * шаг, потребовавший повторов, — проблема промпта; шаг, никогда не выполнившийся, —
 * находка.
 *
 *   bun run smoke/src/run.ts              # все сценарии
 *   bun run smoke/src/run.ts git-block    # один сценарий по id
 *
 * Окружение: HOST_SMOKE_MODEL (по умолчанию: модель из конфигурации opencode),
 *      HOST_SMOKE_PLUGIN (пропустить сборку и упаковку, использовать этот tarball),
 *      HOST_SMOKE_ATTEMPTS (по умолчанию 3).
 */
import { join } from 'node:path';
import {
  REPO_ROOT,
  buildPlugin,
  defaultModel,
  hostVersionFromEnv,
  opencodeBinary,
  startHost,
  stopAllHosts,
  type Host,
} from './harness.ts';
import { OUTPUT_FORMAT, logEvent } from './log.ts';
import { writeSmokeReport } from './report.ts';
import { ATTEMPTS, lastStepState, type ScenarioResult } from './scenario-kit.ts';
import { scenarios, v2Scenarios } from './scenarios/index.ts';
import { runV2Scenario } from './v2-scenario-kit.ts';

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
// ─── Раннер ───────────────────────────────────────────────────────────────────

function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
}
async function main(): Promise<void> {
  installSignalHandlers();
  const hostVersion = hostVersionFromEnv();
  if (hostVersion === 'v2') {
    process.exit((await runV2Smoke()) ? 0 : 1);
  }
  const wanted = process.argv.slice(2);
  const selected = wanted.length
    ? scenarios.filter((scenario) => wanted.includes(scenario.id))
    : scenarios;
  if (selected.length === 0) {
    logEvent(
      `Сценарий не найден. Известные: ${scenarios.map((s) => s.id).join(', ')}`,
      'red',
      'error'
    );
    process.exit(2);
  }

  const binary = opencodeBinary(hostVersion);
  const model = await defaultModel(binary);
  const plugin = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
  process.env.HOST_SMOKE_PLUGIN = plugin;

  logEvent(`модель:  ${model}`, 'gray', 'run.start', { model, plugin, version: hostVersion });
  if (OUTPUT_FORMAT !== 'jsonl') {
    logEvent(`плагин: ${plugin}`, 'gray');
    logEvent(`бинарник: ${binary}`, 'gray');
  }

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const startedAt = Date.now();
    logEvent(`▶ ${scenario.id} …`, 'cyan', 'scenario.start', { scenario: scenario.id });
    const host = await startHost({
      model,
      version: hostVersion,
      profile: scenario.profile ?? 'smoke',
      env: scenario.env,
      files: {
        'commit-task.ts': await Bun.file(join(REPO_ROOT, 'scripts/commit-task.ts')).text(),
        'plan.md': '# Smoke plan\n\nAdd one file under src/.\n',
      },
    });
    try {
      const outcome = await scenario.run(host, model);
      if (!outcome.ok && process.env.HOST_SMOKE_DEBUG) {
        logEvent(
          `  state: ${JSON.stringify(lastStepState()).slice(0, 1200)}`,
          'red',
          'scenario.state'
        );
        const relevant = host
          .logs()
          .split('\n')
          .filter((line) => /session-guard|consent|DIAG|workflow/i.test(line));
        logEvent(
          `  host log:\n    ${relevant.slice(-25).join('\n    ')}`,
          'red',
          'scenario.host-log'
        );
      }
      const durationMs = Date.now() - startedAt;
      results.push({
        id: scenario.id,
        title: scenario.title,
        ...outcome,
        status: outcome.ok ? 'pass' : 'fail',
        durationMs,
      });
      logEvent(
        outcome.ok
          ? `ПРОЙДЕНО (попыток: ${outcome.attempts}, ${formatDuration(durationMs)})`
          : `ОШИБКА (${formatDuration(durationMs)})`,
        outcome.ok ? 'green' : 'red',
        'scenario.result',
        {
          scenario: scenario.id,
          status: outcome.ok ? 'pass' : 'fail',
          attempts: outcome.attempts,
          durationMs,
        }
      );
      if (!outcome.ok)
        logEvent(`  ${outcome.evidence.split('\n').join('\n  ')}`, 'red', 'scenario.evidence');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        title: scenario.title,
        ok: false,
        status: 'fail',
        attempts: 0,
        evidence: `ошибка харнесса: ${message}\n${host.logs().slice(-1500)}`,
        durationMs: Date.now() - startedAt,
      });
      logEvent('ОШИБКА', 'red', 'scenario.result', {
        scenario: scenario.id,
        status: 'error',
        durationMs: Date.now() - startedAt,
      });
      logEvent(`  ${message}`, 'red', 'error');
      if (process.env.HOST_SMOKE_DEBUG)
        logEvent(host.logs().slice(-4000), 'red', 'scenario.host-log');
    } finally {
      await host.stop();
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const averageDurationMs = results.length
    ? results.reduce((total, result) => total + result.durationMs, 0) / results.length
    : 0;
  const report = [
    '# Проверка хоста — session-guard с реальным opencode',
    '',
    `| Модель | \`${model}\` |`,
    '|---|---|',
    `| Версия хоста | ${hostVersion} (\`${binary}\`) |`,
    `| Плагин | \`${plugin.split('/').at(-1)}\` |`,
    `| Результат | ${passed}/${results.length} пройдено |`,
    `| Средняя длительность | ${formatDuration(averageDurationMs)} на сценарий |`,
    '',
    '| № | Сценарий | Результат | Попытки | Длительность | Доказательство |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (result, index) =>
        `| ${index + 1} | ${result.title} | ${result.status === 'pass' ? '**ПРОЙДЕНО**' : result.status === 'blocked' ? '**ЗАБЛОКИРОВАНО**' : '**ОШИБКА**'} | ${
          result.attempts
        } | ${formatDuration(result.durationMs)} | ${result.evidence.replace(/\n/g, ' ').slice(0, 300)} |`
    ),
    '',
  ].join('\n');

  const reportPath = join(REPO_ROOT, 'docs/plans/host-smoke.md');
  await writeSmokeReport(reportPath, report);
  logEvent(
    `\n${passed}/${results.length} пройдено — отчёт записан в ${reportPath}`,
    passed === results.length ? 'green' : 'red',
    'run.summary',
    { passed, total: results.length, averageDurationMs, reportPath }
  );
  process.exit(passed === results.length ? 0 : 1);
}
async function runV2Smoke(): Promise<boolean> {
  const binary = opencodeBinary('v2');
  const model = await defaultModel(binary);
  const plugin = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
  process.env.HOST_SMOKE_PLUGIN = plugin;

  const requested = process.argv.slice(2);
  const selected = requested.length
    ? v2Scenarios.filter((scenario) => requested.includes(scenario.id))
    : v2Scenarios;
  if (selected.length === 0) {
    logEvent(
      `Сценарий V2 не найден. Известные: ${v2Scenarios.map((scenario) => scenario.id).join(', ')}`,
      'red',
      'error'
    );
    return false;
  }

  logEvent(`модель:  ${model}`, 'gray', 'run.start', { model, plugin, version: 'v2' });
  if (OUTPUT_FORMAT !== 'jsonl') {
    logEvent(`плагин: ${plugin}`, 'gray');
    logEvent(`бинарник: ${binary}`, 'gray');
  }

  let passed = 0;
  for (const scenario of selected) {
    const startedAt = Date.now();
    logEvent(`▶ ${scenario.id} …`, 'cyan', 'scenario.start', { scenario: scenario.id });
    let host: Host | undefined;
    try {
      host = await startHost({
        model,
        version: 'v2',
        profile: 'smoke',
        files: { 'plan.md': '# Smoke plan\n\nAdd one file under src/.\n' },
      });
      const outcome = await runV2Scenario(host, scenario, ATTEMPTS);
      const durationMs = Date.now() - startedAt;
      if (outcome.ok) passed += 1;
      logEvent(
        outcome.ok
          ? `ПРОЙДЕНО (попыток: ${outcome.attempts}, ${formatDuration(durationMs)})`
          : `ОШИБКА (${formatDuration(durationMs)})`,
        outcome.ok ? 'green' : 'red',
        'scenario.result',
        {
          scenario: scenario.id,
          status: outcome.ok ? 'pass' : 'fail',
          attempts: outcome.attempts,
          durationMs,
        }
      );
      logEvent(
        `  ${outcome.evidence.split('\n').join('\n  ')}`,
        outcome.ok ? 'gray' : 'red',
        'scenario.evidence'
      );
      if (!outcome.ok && process.env.HOST_SMOKE_DEBUG) {
        logEvent(host.logs().slice(-4000), 'red', 'scenario.host-log');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent('ОШИБКА', 'red', 'scenario.result', {
        scenario: scenario.id,
        status: 'error',
        durationMs: Date.now() - startedAt,
      });
      logEvent(`  ${message}`, 'red', 'error');
      if (process.env.HOST_SMOKE_DEBUG)
        logEvent(host?.logs().slice(-4000) ?? '', 'red', 'scenario.host-log');
    } finally {
      await host?.stop();
    }
  }

  logEvent(
    `\n${passed}/${selected.length} пройдено`,
    passed === selected.length ? 'green' : 'red',
    'run.summary',
    { passed, total: selected.length, version: 'v2' }
  );
  return passed === selected.length;
}
await main();
