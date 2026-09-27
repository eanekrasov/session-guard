/**
 * What the two host runs of one canonical scenario say together, and the single aggregate
 * exit code the CLI returns for a run.
 *
 * `not-run` lives here and only here: it describes unfinished migration or an unavailable
 * live environment, never the verdict of a scenario that ran.
 */

import {
  assertParityReportEntryInvariant,
  createNotRunParityEntry,
  type HostKind,
  type ParityNotRunReason,
  type ParityReportEntry,
  type ScenarioResult,
} from './host/types.ts';

export interface ParityComparison {
  parity: 'pass' | 'limited' | 'fail';
  evidence: string;
}

/**
 * Compare the V1 and V2 result of the same scenario.
 *
 * A blocked side never counts as a pass: parity is `limited` when only one side ran into a
 * confirmed host limitation, and a parity defect when the two sides behave differently for no
 * documented reason. A side that failed without the plugin ever completing an action is not
 * evidence of a defect either: the live model did not perform the instruction, so behavioral
 * parity is simply not confirmed by this run and the evidence says so.
 */
export function compareHostResults(v1: ScenarioResult, v2: ScenarioResult): ParityComparison {
  const both = `V1: ${v1.status}, V2: ${v2.status}`;
  const unconfirmed = (result: ScenarioResult): string | undefined => {
    if (result.status !== 'fail') return undefined;
    if (result.failureKind === 'host') return undefined;
    const kind = result.failureKind ?? 'unknown';
    return `на ${result.hostKind} сценарий не подтверждён по вине модели/harness (failureKind=${kind})`;
  };

  if (v1.status === 'fail' || v2.status === 'fail') {
    const reasons = [unconfirmed(v1), unconfirmed(v2)].filter(
      (reason): reason is string => reason !== undefined
    );
    // Only a failure with observable plugin behaviour is a parity defect.
    const provenDefect =
      (v1.status === 'fail' && unconfirmed(v1) === undefined) ||
      (v2.status === 'fail' && unconfirmed(v2) === undefined);
    if (provenDefect) {
      return {
        parity: 'fail',
        evidence: `${both} — ожидаемая семантика сценария достигнута не на обоих host kinds`,
      };
    }
    return {
      parity: 'limited',
      evidence: `${both} — behavioral parity не подтверждён: ${reasons.join('; ')}; прогон нужно повторить`,
    };
  }
  if (v1.status === 'pass' && v2.status === 'pass') {
    return {
      parity: 'pass',
      evidence: `${both} — одинаковая ожидаемая семантика на обоих host kinds`,
    };
  }
  if (v1.status === 'pass' || v2.status === 'pass') {
    const blocked = v1.status === 'blocked' ? v1 : v2;
    return {
      parity: 'limited',
      evidence: `${both} — ограничение host contract: ${blocked.blockedReason}`,
    };
  }
  if (v1.blockedReason === v2.blockedReason) {
    return {
      parity: 'limited',
      evidence: `${both} — одинаковое подтверждённое ограничение ${v1.blockedReason}`,
    };
  }
  return {
    parity: 'fail',
    evidence: `${both} — стороны ограничены по-разному (${v1.blockedReason} против ${v2.blockedReason})`,
  };
}

export function parityEntryFromResults(
  scenarioId: string,
  v1: ScenarioResult,
  v2: ScenarioResult
): ParityReportEntry {
  const comparison = compareHostResults(v1, v2);
  const entry: ParityReportEntry = {
    scenarioId,
    v1,
    v2,
    parity: comparison.parity,
    evidence: comparison.evidence,
  };
  assertParityReportEntryInvariant(entry);
  return entry;
}

/** A scenario that has no result on either host kind, with the reason it has none. */
export function notRunEntry(
  scenarioId: string,
  notRunReason: ParityNotRunReason,
  evidence: string
): ParityReportEntry {
  const entry = createNotRunParityEntry({ scenarioId, evidence, notRunReason });
  assertParityReportEntryInvariant(entry);
  return entry;
}

/**
 * One row for a scenario whose other host kind never became available.
 *
 * The side that ran keeps its result, and the verdict is `not-run` with the closed reason, so
 * a partial run is still one row with V1 status, V2 status, parity and evidence. It is never
 * `limited`: nothing about the missing side's behaviour was observed.
 */
export function parityEntryFromPartialResults(
  scenarioId: string,
  results: Partial<Record<HostKind, ScenarioResult>>,
  notRunReason: ParityNotRunReason,
  evidence: string
): ParityReportEntry {
  const entry: ParityReportEntry = {
    scenarioId,
    ...(results.v1 === undefined ? {} : { v1: results.v1 }),
    ...(results.v2 === undefined ? {} : { v2: results.v2 }),
    parity: 'not-run',
    notRunReason,
    evidence,
  };
  assertParityReportEntryInvariant(entry);
  return entry;
}

/**
 * One row for a run that deliberately measured a single host kind.
 *
 * The verdict is `limited`, never `pass`: one side of the comparison does not exist in this
 * run, so no behavioral parity was measured. The evidence says so, and the row stays in the
 * parity table instead of dropping the scenario out of it.
 */
export function singleHostParityEntry(
  scenarioId: string,
  result: ScenarioResult
): ParityReportEntry {
  const entry: ParityReportEntry = {
    scenarioId,
    parity: 'limited',
    evidence: `запущен только host kind ${result.hostKind}; паритет V1/V2 в этом прогоне не измерялся`,
  };
  if (result.hostKind === 'v1') entry.v1 = result;
  else entry.v2 = result;
  assertParityReportEntryInvariant(entry);
  return entry;
}

/**
 * One parity row per scenario, or the report lies about what was compared.
 *
 * A duplicate cannot come from a correct run, so it is refused instead of printed: the
 * parity table is evidence, and two rows for one scenario would make its verdict ambiguous.
 */
export function assertSingleEntryPerScenario(entries: ParityReportEntry[]): void {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.scenarioId)) duplicated.add(entry.scenarioId);
    seen.add(entry.scenarioId);
  }
  if (duplicated.size > 0) {
    throw new Error(
      `[ERROR] сценарий встречается в parity report дважды: ${[...duplicated].join(', ')}`
    );
  }
}

export interface AggregateInput {
  /** Results of the scenarios that actually ran, across every host kind of this run. */
  results: ScenarioResult[];
  /** Scenarios that produced no result, each with its closed reason. */
  notRun: ParityReportEntry[];
  /** A fatal adapter or bootstrap failure: the run could not start at all. */
  fatal?: boolean;
}

/**
 * The one exit-code path for both host kinds.
 *
 * `0` every required runnable scenario passed and nothing is unfinished; `1` any failure;
 * `2` nothing ran and nothing explains why, or a fatal adapter/bootstrap error; `3` a
 * blocked verdict without a failure; `4` only unfinished migration; `5` an unavailable live
 * environment for a migrated required scenario.
 *
 * Priority: fail/fatal, then blocked, then unavailable live environment, then pending
 * migration. Every not-run reason is therefore read before the empty-run fallback: a
 * selection that holds only `pending-migration` is unfinished migration (`4`), and one whose
 * host never started is an unavailable live environment (`5`) — neither is "nothing to run".
 */
export function aggregateExitCode(input: AggregateInput): number {
  if (input.fatal) return 2;
  if (input.results.some((result) => result.status === 'fail')) return 1;
  if (input.results.some((result) => result.status === 'blocked')) return 3;
  if (input.notRun.some((entry) => entry.notRunReason === 'live-environment-unavailable')) {
    return 5;
  }
  if (input.notRun.some((entry) => entry.notRunReason === 'pending-migration')) return 4;
  // Nothing ran and no scenario accounted for it: the selection had no runnable scenario.
  if (input.results.length === 0) return 2;
  return 0;
}
