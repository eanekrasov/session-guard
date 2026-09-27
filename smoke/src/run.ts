#!/usr/bin/env bun
/**
 * host-smoke — drives the plugin through a real opencode.
 *
 * Every assertion here is made against what the host and the plugin actually
 * did: the session the plugin persisted, and the tool parts the host recorded.
 * Nothing calls into the plugin directly, so a scenario that passes here is
 * evidence the mechanism works in production, not that a unit test agrees with
 * itself.
 *
 * A live model drives the tools, so a step can fail because the model ignored
 * the instruction rather than because the plugin misbehaved. Each step is
 * therefore retried, and the report records how many attempts it took: a step
 * that needed retries is a prompt problem, a step that never succeeded is a
 * finding.
 *
 *   bun run smoke/src/run.ts              # every scenario
 *   bun run smoke/src/run.ts git-block    # one scenario by id
 *
 * Env: HOST_SMOKE_MODEL (default: the model in your opencode config),
 *      HOST_SMOKE_PLUGIN (skip build+pack, use this tarball),
 *      HOST_SMOKE_ATTEMPTS (default 3).
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
import { scenarios } from './scenarios/index.ts';
import { V2_SCENARIOS, runV2Scenario } from './v2-scenarios.ts';

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
// ─── Runner ───────────────────────────────────────────────────────────────────

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
    logEvent(`No such scenario. Known: ${scenarios.map((s) => s.id).join(', ')}`, 'red', 'error');
    process.exit(2);
  }

  const binary = opencodeBinary(hostVersion);
  const model = await defaultModel(binary);
  const plugin = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
  process.env.HOST_SMOKE_PLUGIN = plugin;

  logEvent(`model:  ${model}`, 'gray', 'run.start', { model, plugin, version: hostVersion });
  if (OUTPUT_FORMAT !== 'jsonl') {
    logEvent(`plugin: ${plugin}`, 'gray');
    logEvent(`opencode: ${binary}`, 'gray');
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
          ? `PASS (${outcome.attempts} attempt(s), ${formatDuration(durationMs)})`
          : `FAIL (${formatDuration(durationMs)})`,
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
        evidence: `harness error: ${message}\n${host.logs().slice(-1500)}`,
        durationMs: Date.now() - startedAt,
      });
      logEvent('ERROR', 'red', 'scenario.result', {
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
    '# Host smoke — session-guard against a real opencode',
    '',
    `| Model | \`${model}\` |`,
    '|---|---|',
    `| Host version | ${hostVersion} (\`${binary}\`) |`,
    `| Plugin | \`${plugin.split('/').at(-1)}\` |`,
    `| Result | ${passed}/${results.length} scenarios passed |`,
    `| Average duration | ${formatDuration(averageDurationMs)} per scenario |`,
    '',
    '| # | Scenario | Result | Attempts | Duration | Evidence |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (result, index) =>
        `| ${index + 1} | ${result.title} | ${result.status === 'pass' ? '**PASS**' : result.status === 'blocked' ? '**BLOCKED**' : '**FAIL**'} | ${
          result.attempts
        } | ${formatDuration(result.durationMs)} | ${result.evidence.replace(/\n/g, ' ').slice(0, 300)} |`
    ),
    '',
  ].join('\n');

  const reportPath = join(REPO_ROOT, 'docs/plans/host-smoke.md');
  await writeSmokeReport(reportPath, report);
  logEvent(
    `\n${passed}/${results.length} passed — report written to ${reportPath}`,
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
    ? V2_SCENARIOS.filter((scenario) => requested.includes(scenario.id))
    : V2_SCENARIOS;
  if (selected.length === 0) {
    logEvent(
      `No such V2 scenario. Known: ${V2_SCENARIOS.map((scenario) => scenario.id).join(', ')}`,
      'red',
      'error'
    );
    return false;
  }

  logEvent(`model:  ${model}`, 'gray', 'run.start', { model, plugin, version: 'v2' });
  if (OUTPUT_FORMAT !== 'jsonl') {
    logEvent(`plugin: ${plugin}`, 'gray');
    logEvent(`opencode: ${binary}`, 'gray');
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
          ? `PASS (${outcome.attempts} attempt(s), ${formatDuration(durationMs)})`
          : `FAIL (${formatDuration(durationMs)})`,
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
      logEvent('ERROR', 'red', 'scenario.result', {
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
    `\n${passed}/${selected.length} passed`,
    passed === selected.length ? 'green' : 'red',
    'run.summary',
    { passed, total: selected.length, version: 'v2' }
  );
  return passed === selected.length;
}
await main();
