import { describe, expect, test } from 'bun:test';

import { formatJsonlEvent } from '../src/log.ts';
import {
  aggregateExitCode,
  assertSingleEntryPerScenario,
  compareHostResults,
  notRunEntry,
  parityEntryFromPartialResults,
  parityEntryFromResults,
  singleHostParityEntry,
} from '../src/parity.ts';
import { renderParityReport } from '../src/report.ts';
import { createBlockedResult } from '../src/host/types.ts';
import type {
  BlockedReason,
  FailureKind,
  HostKind,
  ParityReportEntry,
  ScenarioResult,
} from '../src/host/types.ts';

function result(
  hostKind: HostKind,
  status: 'pass' | 'fail',
  evidence = 'наблюдение',
  failureKind?: FailureKind
): ScenarioResult {
  return {
    id: 'create',
    title: 'Create workflow',
    hostKind,
    status,
    attempts: 1,
    durationMs: 10,
    evidence,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

function blocked(hostKind: HostKind, blockedReason: BlockedReason): ScenarioResult {
  return createBlockedResult({
    id: 'create',
    title: 'Create workflow',
    hostKind,
    attempts: 1,
    durationMs: 10,
    evidence: `ограничение: ${blockedReason}`,
    blockedReason,
  });
}

describe('comparing the two host runs of one scenario', () => {
  test('calls identical expected semantics a pass', () => {
    const comparison = compareHostResults(result('v1', 'pass'), result('v2', 'pass'));

    expect(comparison.parity).toBe('pass');
    expect(comparison.evidence).toContain('V1: pass, V2: pass');
  });

  test('does not compare the wording of the host or the model', () => {
    // A negative scenario: both hosts refused, and the prose differs on purpose.
    const v1 = result('v1', 'pass', 'commit refused: no entry covers src/a.ts');
    const v2 = result('v2', 'pass', 'Отказано: разрешение не покрывает src/a.ts');

    expect(compareHostResults(v1, v2).parity).toBe('pass');
  });

  test('calls a one-sided limitation limited, never a pass', () => {
    const comparison = compareHostResults(
      result('v1', 'pass'),
      blocked('v2', 'required_host_capability_unavailable')
    );

    expect(comparison.parity).toBe('limited');
    expect(comparison.evidence).toContain('required_host_capability_unavailable');
  });

  test('accepts an identical confirmed limitation on both sides as limited', () => {
    const comparison = compareHostResults(
      blocked('v1', 'adapter_contract_mismatch'),
      blocked('v2', 'adapter_contract_mismatch')
    );

    expect(comparison.parity).toBe('limited');
  });

  test('treats differently limited sides and a proven host failure as a parity defect', () => {
    expect(
      compareHostResults(
        blocked('v1', 'adapter_contract_mismatch'),
        blocked('v2', 'indeterminate_mutation')
      ).parity
    ).toBe('fail');
    expect(
      compareHostResults(
        result('v1', 'pass'),
        result('v2', 'fail', 'plugin ответил ошибкой', 'host')
      ).parity
    ).toBe('fail');
    expect(
      compareHostResults(
        result('v1', 'fail', 'x', 'host'),
        blocked('v2', 'adapter_contract_mismatch')
      ).parity
    ).toBe('fail');
  });

  test('does not call a live-model failure a parity defect', () => {
    // The instruction never produced a completed plugin action, so nothing about the host
    // contract was observed: behavioral parity is simply not confirmed by this run.
    const modelFailure = compareHostResults(
      result('v1', 'pass'),
      result('v2', 'fail', 'инструкция не выполнена', 'model')
    );

    expect(modelFailure.parity).toBe('limited');
    expect(modelFailure.evidence).toContain('behavioral parity не подтверждён');
    expect(modelFailure.evidence).toContain('failureKind=model');
    expect(modelFailure.evidence).toContain('нужно повторить');

    // An indefinite failure and a failure class nobody could establish behave the same way.
    expect(
      compareHostResults(result('v1', 'pass'), result('v2', 'fail', 'x', 'unknown')).parity
    ).toBe('limited');
    expect(compareHostResults(result('v1', 'pass'), result('v2', 'fail')).parity).toBe('limited');
    expect(
      compareHostResults(result('v1', 'fail', 'x', 'model'), result('v2', 'fail', 'y', 'model'))
        .parity
    ).toBe('limited');
  });

  test('keeps both results and the comparison in the parity entry', () => {
    const entry = parityEntryFromResults(
      'create',
      result('v1', 'pass'),
      blocked('v2', 'required_host_capability_unavailable')
    );

    expect(entry.v1?.status).toBe('pass');
    expect(entry.v2?.status).toBe('blocked');
    expect(entry.parity).toBe('limited');
    expect(entry.notRunReason).toBeUndefined();
  });

  test('refuses a report where one scenario appears twice', () => {
    // The parity table is evidence: two verdicts for one scenario would make it ambiguous,
    // and this guard is what caught a duplicate row during a live run.
    expect(() =>
      assertSingleEntryPerScenario([
        parityEntryFromResults('create', result('v1', 'pass'), result('v2', 'pass')),
        notRunEntry('commit-gate', 'pending-migration', 'не мигрирован'),
      ])
    ).not.toThrow();

    expect(() =>
      assertSingleEntryPerScenario([
        parityEntryFromResults('create', result('v1', 'pass'), result('v2', 'pass')),
        notRunEntry('create', 'pending-migration', 'не мигрирован'),
      ])
    ).toThrow('сценарий встречается в parity report дважды: create');
  });

  test('refuses a not-run entry without its reason', () => {
    const entry = notRunEntry('commit-gate', 'pending-migration', 'стадия mutation не мигрирована');

    expect(entry).toMatchObject({ parity: 'not-run', notRunReason: 'pending-migration' });
    expect(entry.v1).toBeUndefined();
    expect(entry.v2).toBeUndefined();
  });
});

describe('the aggregate exit code', () => {
  const pending: ParityReportEntry = notRunEntry(
    'commit-gate',
    'pending-migration',
    'не мигрирован'
  );
  const unavailable: ParityReportEntry = notRunEntry(
    'create',
    'live-environment-unavailable',
    'хост v2 недоступен'
  );

  test('is zero only when everything runnable passed and nothing is unfinished', () => {
    expect(
      aggregateExitCode({ results: [result('v1', 'pass'), result('v2', 'pass')], notRun: [] })
    ).toBe(0);
  });

  test('maps every unfinished state to its own code', () => {
    expect(aggregateExitCode({ results: [result('v1', 'fail')], notRun: [] })).toBe(1);
    expect(
      aggregateExitCode({ results: [blocked('v1', 'indeterminate_mutation')], notRun: [] })
    ).toBe(3);
    expect(aggregateExitCode({ results: [result('v1', 'pass')], notRun: [unavailable] })).toBe(5);
    expect(aggregateExitCode({ results: [result('v1', 'pass')], notRun: [pending] })).toBe(4);
  });

  test('reads the not-run reason before the empty-run fallback', () => {
    // A selection that holds only unfinished migration is unfinished migration, and a host
    // that never started is an unavailable environment: neither is "nothing to run".
    expect(aggregateExitCode({ results: [], notRun: [pending] })).toBe(4);
    expect(aggregateExitCode({ results: [], notRun: [unavailable] })).toBe(5);
    expect(aggregateExitCode({ results: [], notRun: [pending, unavailable] })).toBe(5);
  });

  test('reports a fatal run and a run with nothing at all as two', () => {
    expect(aggregateExitCode({ results: [], notRun: [pending], fatal: true })).toBe(2);
    expect(aggregateExitCode({ results: [], notRun: [] })).toBe(2);
  });

  test('applies the documented priority: fail, blocked, unavailable environment, pending migration', () => {
    const all = {
      results: [result('v1', 'fail'), blocked('v2', 'adapter_contract_mismatch')],
      notRun: [unavailable, pending],
    };

    expect(aggregateExitCode(all)).toBe(1);
    expect(
      aggregateExitCode({ ...all, results: [blocked('v2', 'adapter_contract_mismatch')] })
    ).toBe(3);
    expect(aggregateExitCode({ ...all, results: [] })).toBe(5);
    expect(aggregateExitCode({ ...all, results: [], notRun: [pending] })).toBe(4);
  });

  test('keeps a passing stage-1 run unfinished while scenarios stay unmigrated', () => {
    // plugin-loads and create pass on both kinds, the rest are pending: the stage still
    // reports its own incompleteness instead of a green summary.
    expect(
      aggregateExitCode({
        results: [result('v1', 'pass'), result('v2', 'pass')],
        notRun: [pending, notRunEntry('no-session', 'pending-migration', 'стадия stage-2-core')],
      })
    ).toBe(4);
  });
});

describe('the run report', () => {
  const matrix = [
    { scenarioId: 'create', requiredOn: { v1: true, v2: true }, reason: 'stage-1-core: migrated' },
  ];

  test('prints both host kinds of one scenario in one schema', () => {
    const report = renderParityReport({
      mode: 'parity',
      model: 'crpt/model',
      plugin: '/repo/dist',
      hosts: [
        { kind: 'v1', binary: '/bin/v1' },
        { kind: 'v2', binary: '/bin/v2' },
      ],
      results: [result('v1', 'pass', 'V1 evidence'), result('v2', 'fail', 'V2 evidence', 'host')],
      entries: [
        parityEntryFromResults(
          'create',
          result('v1', 'pass'),
          result('v2', 'fail', 'plugin ответил ошибкой', 'host')
        ),
        notRunEntry('commit-gate', 'pending-migration', 'не мигрирован'),
      ],
      matrix,
      exitCode: 1,
      durationMs: 1234,
    });

    expect(report).toContain('| `create` | V1 | **ПРОЙДЕНО** | 1 | 0.0s | V1 evidence |');
    expect(report).toContain('| `create` | V2 | **ОШИБКА** | 1 | 0.0s | V2 evidence |');
    expect(report).toContain('| `create` | **ПРОЙДЕНО** | **ОШИБКА** | fail |');
    expect(report).toContain(
      '| `commit-gate` | — | — | not-run (pending-migration) | не мигрирован |'
    );
    expect(report).toContain('| `create` | да | да | stage-1-core: migrated |');
    expect(report).toContain('| Код выхода | 1 |');
    expect(report).toContain('Коды выхода:');
  });

  test('keeps one parity row for a scenario whose other host kind never came up', () => {
    const entry = parityEntryFromPartialResults(
      'create',
      { v1: result('v1', 'pass') },
      'live-environment-unavailable',
      'хост v2: бинарник opencode v2 не найден'
    );
    const report = renderParityReport({
      mode: 'parity',
      model: 'crpt/model',
      plugin: '/repo/dist',
      hosts: [{ kind: 'v1', binary: '/bin/v1' }],
      results: [result('v1', 'pass')],
      entries: [entry],
      matrix,
      exitCode: 5,
      durationMs: 1,
    });

    expect(entry.v1?.status).toBe('pass');
    expect(entry.v2).toBeUndefined();
    expect(report).toContain(
      '| `create` | **ПРОЙДЕНО** | — | not-run (live-environment-unavailable) | хост v2: бинарник'
    );
  });

  test('records the failure class of a live-model failure instead of a defect row', () => {
    const report = renderParityReport({
      mode: 'parity',
      model: 'crpt/model',
      plugin: '/repo/dist',
      hosts: [
        { kind: 'v1', binary: '/bin/v1' },
        { kind: 'v2', binary: '/bin/v2' },
      ],
      results: [
        result('v1', 'pass'),
        result('v2', 'fail', 'класс отказа: инструкцию не выполнила модель', 'model'),
      ],
      entries: [
        parityEntryFromResults(
          'create',
          result('v1', 'pass'),
          result('v2', 'fail', 'класс отказа: инструкцию не выполнила модель', 'model')
        ),
      ],
      matrix,
      exitCode: 1,
      durationMs: 1,
    });

    expect(report).toContain('| `create` | **ПРОЙДЕНО** | **ОШИБКА** | limited |');
    expect(report).toContain('behavioral parity не подтверждён');
  });

  test('never masks a blocked verdict as a pass, and always names its reason', () => {
    const report = renderParityReport({
      mode: 'parity',
      model: 'crpt/model',
      plugin: '/repo/dist',
      hosts: [{ kind: 'v1', binary: '/bin/v1' }],
      results: [blocked('v1', 'indeterminate_mutation')],
      entries: [],
      matrix,
      exitCode: 3,
      durationMs: 1,
    });

    expect(report).toContain('**ЗАБЛОКИРОВАНО** (indeterminate_mutation)');
    expect(report).not.toContain('ПРОЙДЕНО');
  });

  test('records a single-host run as a limited row instead of dropping the scenario', () => {
    const entry = singleHostParityEntry('create', result('v2', 'pass'));
    const report = renderParityReport({
      mode: 'single-host',
      model: 'crpt/model',
      plugin: '/repo/dist',
      hosts: [{ kind: 'v2', binary: '/bin/v2' }],
      results: [result('v2', 'pass')],
      entries: [entry],
      matrix,
      exitCode: 0,
      durationMs: 1,
    });

    expect(entry.parity).toBe('limited');
    expect(entry.v2?.status).toBe('pass');
    expect(report).toContain('single-host');
    expect(report).toContain('паритет V1/V2 требует запуска обоих');
    expect(report).toContain(
      '| `create` | — | **ПРОЙДЕНО** | limited | запущен только host kind v2; паритет V1/V2 в этом прогоне не измерялся |'
    );
  });
});

describe('the machine-readable output', () => {
  test('serializes one whole event per line, however long the message is', () => {
    const line = formatJsonlEvent({
      timestamp: '2026-09-27T00:00:00.000Z',
      type: 'scenario.evidence',
      message: 'first line\nsecond line',
      scenario: 'create',
      attempts: 2,
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n').filter((entry) => entry !== '')).toHaveLength(1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.message).toBe('first line\nsecond line');
    expect(parsed.scenario).toBe('create');
    expect(parsed.attempts).toBe(2);
    expect(parsed.type).toBe('scenario.evidence');
    expect(parsed.timestamp).toBe('2026-09-27T00:00:00.000Z');
  });
});
