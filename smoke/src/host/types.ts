export type HostKind = 'v1' | 'v2';

export interface SmokeSession {
  id: string;
  hostKind: HostKind;
}

export interface PromptInput {
  text: string;
  agent?: string;
}

export type NormalizedPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      tool: string;
      /**
       * What the host reported about the call. Optional because a part that carries only
       * output (or only an error) still describes the same call; the transports fill it in
       * when the host states it explicitly.
       */
      status?: NormalizedToolCall['status'];
      output?: string;
      error?: string;
    }
  | { kind: 'error'; error: string }
  | { kind: 'unknown'; text?: string };

export interface NormalizedToolCall {
  name: string;
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  output?: string;
  error?: string;
}

export interface NormalizedTurn {
  status: 'completed' | 'timed-out' | 'failed' | 'unknown';
  transcript: string;
  parts: NormalizedPart[];
  toolCalls: NormalizedToolCall[];
  pendingInteraction?: boolean;
}

export interface SmokeWorkflowState {
  sessionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  /**
   * Stage the state machine is on, as the plugin persisted it. A scenario proves
   * progress with this instead of matching prose the model produced.
   */
  currentStage?: string;
  /** Persisted task lists by list key (`implementation`, `test_suite`, ...). */
  tasks?: Record<string, Array<{ status?: string }>>;
  operationId?: string;
  operationStatus?: 'pending' | 'completed' | 'failed' | 'unknown';
  /**
   * Whether durable state exists for this host session. `none` means the facade read the
   * plugin's store and found nothing, which is the only observable proof that a mutating
   * instruction left no durable mutation. A store that exists but cannot be vouched for —
   * unreadable, or not a workflow session — is never reported as `null`; reading it fails
   * instead, so absence is never inferred from a payload nobody could check.
   */
  durableMutation?: 'none' | 'applied' | 'unknown';
}

/**
 * What the host showed about the plugin during one turn.
 *
 * Neither host exposes the plugin's registered tool surface: on V2 `plugin.list` reports only
 * `{id, source, features, state}`, and V1 has no tool catalogue at all. The evidence therefore
 * states what was *observed in host execution*, never a registry it cannot read — hence
 * `observedPluginTools`, and `loaded` inferred from an observed plugin call.
 */
export interface PluginObservation {
  /** The plugin provably loaded: at least one `workflow-*` tool call was observed. */
  loaded: boolean;
  /** The plugin tools the host reported as invoked, in the order it reported them. */
  observedPluginTools: string[];
  invokedTools: NormalizedToolCall[];
  hostOperation: 'real-host' | 'unknown';
  result: 'success' | 'error' | 'unknown';
}

export interface PromptResult {
  turn: NormalizedTurn;
  workflowState: SmokeWorkflowState | null;
  pluginEvidence: PluginObservation;
}

export type MigrationState = 'migrated' | 'pending';
export type RetryStrategy = 'same-session' | 'new-session' | 'poll-state' | 'none';

export interface ScenarioStep {
  instruction: string;
  mutation: 'read-only' | 'mutating';
  retry: RetryStrategy;
  expect: (result: PromptResult) => true | string;
}

interface ScenarioDefinitionBase {
  id: string;
  title: string;
  profile?: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
  git?: boolean;
  agent?: string;
}

export interface MigratedScenarioDefinition extends ScenarioDefinitionBase {
  migrationState: 'migrated';
  steps: ScenarioStep[];
}

export interface PendingScenarioDefinition extends ScenarioDefinitionBase {
  migrationState: 'pending';
  steps?: ScenarioStep[];
}

export type ScenarioDefinition = MigratedScenarioDefinition | PendingScenarioDefinition;

export type BlockedReason =
  'adapter_contract_mismatch' | 'required_host_capability_unavailable' | 'indeterminate_mutation';

export type ParityNotRunReason = 'pending-migration' | 'live-environment-unavailable';

interface ScenarioResultBase {
  id: string;
  title: string;
  hostKind: HostKind;
  attempts: number;
  durationMs: number;
  evidence: string;
}

/**
 * What a failing scenario's evidence proved about the failure itself.
 *
 * - `model` — the instruction produced no completed plugin action, so the plugin's behaviour
 *   was never observed: a live-model failure, which does not prove the host or the transport
 *   is broken and only asks for another live run;
 * - `host` — a plugin tool did complete and the expectation still failed: the plugin or the
 *   host produced observable behaviour that does not match the scenario;
 * - `unknown` — a plugin tool was invoked but nothing completed, so the transcript decides.
 *
 * A model failure is deliberately not the same verdict as a host failure: only the latter may
 * be read as a parity defect.
 */
export type FailureKind = 'model' | 'host' | 'unknown';

export type ScenarioResult =
  | (ScenarioResultBase & {
      status: 'pass' | 'fail';
      blockedReason?: never;
      /** Present on a failing scenario; absent on a pass. */
      failureKind?: FailureKind;
    })
  | (ScenarioResultBase & { status: 'blocked'; blockedReason: BlockedReason });

export interface ParityReportEntry {
  scenarioId: string;
  v1?: ScenarioResult;
  v2?: ScenarioResult;
  parity: 'pass' | 'limited' | 'fail' | 'not-run';
  notRunReason?: ParityNotRunReason;
  evidence: string;
}

export function createBlockedResult(
  result: Omit<ScenarioResultBase, 'hostKind'> & {
    hostKind: HostKind;
    blockedReason: BlockedReason;
  }
): ScenarioResult {
  return { ...result, status: 'blocked' };
}

export function createNotRunParityEntry(
  entry: Omit<ParityReportEntry, 'parity' | 'notRunReason' | 'v1' | 'v2'> & {
    notRunReason: ParityNotRunReason;
  }
): ParityReportEntry {
  return { ...entry, parity: 'not-run' };
}

export function assertScenarioResultInvariant(result: ScenarioResult): void {
  if (result.status === 'blocked' && result.blockedReason === undefined) {
    throw new Error('[ERROR] blocked scenario result requires blockedReason');
  }
  if (result.status !== 'blocked' && result.blockedReason !== undefined) {
    throw new Error('[ERROR] blockedReason is only valid for blocked scenario results');
  }
  if (result.status === 'pass' && result.failureKind !== undefined) {
    throw new Error('[ERROR] failureKind is only valid for a failing scenario result');
  }
}

export function assertParityReportEntryInvariant(entry: ParityReportEntry): void {
  if (entry.parity === 'not-run' && entry.notRunReason === undefined) {
    throw new Error('[ERROR] not-run parity entry requires notRunReason');
  }
  if (entry.parity !== 'not-run' && entry.notRunReason !== undefined) {
    throw new Error('[ERROR] notRunReason is only valid for not-run parity entries');
  }
}
