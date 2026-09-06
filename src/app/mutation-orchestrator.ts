import { resolve, join } from 'node:path';
import type { WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';
import { StateMachineEngine, type EvaluateGuardFn, type EngineConfig } from '../domain/engine.ts';
import { resolveConfig } from '../public-api.ts';
import { compileWorkflow } from '../schema/compile-workflow.ts';
import { mergeStages } from '../schema/schema-loader.ts';
import { ProfileConfigurationError } from '../schema/types.ts';
import { GuardEvaluator } from '../schema/guard-evaluator.ts';
import type { ResolvedSchema } from '../schema/types.ts';
import { SessionQueue } from './session-queue.ts';
import { WorkflowBlockedError } from './blocked-error.ts';
import { computeChangeScope, type BaselineHashes } from './change-scope.ts';
import { getAllProfileInvariants, validateFiles, SUPPORTED_EXTENSIONS } from './invariants.ts';
import {
  beginMutation,
  finishMutation as domainFinishMutation,
  clearActiveMutation,
  isExpiredMutation,
} from '../domain/operation-lifecycle.ts';
import type { LogFn, LogLevel } from './logger.ts';
import type { SessionClient } from './runtime-types.ts';

// ─── Types ───────────────────────────────────────────────────────────────

export interface FinishMutationInput {
  sessionID: string;
  callID: string;
  /** Tool execution metadata — `{ failed?: boolean }` signals mutation failure. */
  metadata?: unknown;
}

// ─── Pure helper: merge ResolvedSchema[] → EngineConfig ──────────

/**
 * Merge ResolvedSchema[] → EngineConfig:
 * - transitions: full override (last schema wins)
 * - actionGuards: concat + unique
 */
export function mergeSchemasToEngineConfig(schemas: ResolvedSchema[]): EngineConfig {
  const stageAssignmentMap = new Map<string, import('../schema/types.ts').StageAssignmentRule>();
  // Same rule as schema inheritance: a later schema refines a stage rather than
  // replacing it, so declaring a roster does not drop the loop and transitions
  // declared alongside it.
  let stages: NonNullable<EngineConfig['stages']> = {};
  for (const schema of schemas) {
    stages = (mergeStages(stages, schema.stages) ?? stages) as NonNullable<EngineConfig['stages']>;
    for (const rule of schema.stageAssignments ?? []) {
      stageAssignmentMap.set(rule.id, rule);
    }
  }
  const transitionsMap = new Map<string, NonNullable<ResolvedSchema['transitions']>[number]>();
  const actionGuardMap: Record<string, string> = {};
  let requiredGates: string[] | undefined;
  let taskControlAgents: string[] | undefined;

  for (const schema of schemas) {
    // Merge transitions: full override by "from→to" key
    for (const t of schema.transitions ?? []) {
      transitionsMap.set(`${t.from}→${t.to}`, t);
    }

    // Merge actionGuards: last schema's value for each action wins
    if (schema.actionGuards) {
      for (const [action, guard] of Object.entries(schema.actionGuards)) {
        if (typeof guard === 'string') {
          actionGuardMap[action] = guard;
        }
      }
    }

    if (schema.requiredGates !== undefined) {
      requiredGates = [...schema.requiredGates];
    }

    if (schema.taskControlAgents !== undefined) {
      taskControlAgents = [...schema.taskControlAgents];
    }
  }

  return {
    stages: Object.keys(stages).length > 0 ? stages : undefined,
    stageAssignments: Array.from(stageAssignmentMap.values()),
    transitions: Array.from(transitionsMap.values()),
    actionGuards: Object.keys(actionGuardMap).length > 0 ? actionGuardMap : undefined,
    requiredGates,
    taskControlAgents,
  };
}

// ─── Pure: processScopeAndInvariants ───────────────────────────────────────────

export interface ScopeProcessInput {
  session: WorkflowSession;
  scopeRoot: string;
  projectDir: string;
  profilesDir: string;
  metadataFailed: boolean;
  log: (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>;
  onDiagnostics?: (text: string) => void;
}

/**
 * Pure function: compute scope → run invariant validation → determine finalPassed.
 *
 * Extracted from MutationOrchestrator.finishMutation for testability.
 * Does NOT touch the session store or queue — only mutates session.changedFiles
 * and returns the pass/fail decision and any diagnostics text.
 */
export async function processScopeAndInvariants(
  input: ScopeProcessInput
): Promise<{ finalPassed: boolean; scopeError: string | null }> {
  const { session, scopeRoot, projectDir, profilesDir, metadataFailed, log, onDiagnostics } = input;

  let changedFiles: string[] = [];
  let scopeError: string | null = null;

  if (scopeRoot) {
    try {
      changedFiles = await computeChangeScope(scopeRoot, {} as BaselineHashes);
    } catch (err) {
      scopeError = err instanceof Error ? err.message : String(err);
      changedFiles = [];
      onDiagnostics?.(`\n\n[workflow-scope-error]\nChange scope computation failed: ${scopeError}`);
    }
  }

  const sorted = [...changedFiles].sort();
  session.changedFiles = sorted;

  let finalPassed = !metadataFailed;

  if (scopeError !== null) {
    finalPassed = false;
    await log('warn', 'finishMutation: change scope failed, gate set to failed', {
      sessionId: session.sessionId,
      error: scopeError,
    });
  }

  // Run invariant validation (если passed)
  if (finalPassed) {
    const existingFiles = sorted.filter((f) => SUPPORTED_EXTENSIONS.test(f));
    if (existingFiles.length > 0) {
      try {
        const absoluteFiles = existingFiles.map((f) => resolve(projectDir, f));
        const invariants = await getAllProfileInvariants(session.profileId, profilesDir);
        const result = validateFiles(absoluteFiles, invariants, projectDir);
        if (result.errors.length > 0) {
          finalPassed = false;
          await log('warn', 'finishMutation: invariant validation failed', {
            sessionId: session.sessionId,
            errors: result.errors.length,
          });
          onDiagnostics?.(
            `\n\n[workflow-validation-failed]\n${result.errors
              .map((e: { invariant: string; message: string }) => `${e.invariant}: ${e.message}`)
              .join('\n')}`
          );
        }
        if (result.warnings.length > 0) {
          onDiagnostics?.(
            `\n\n[workflow-validation-warnings]\n${result.warnings
              .map((w: { invariant: string; message: string }) => `${w.invariant}: ${w.message}`)
              .join('\n')}`
          );
        }
      } catch (err) {
        finalPassed = false;
        await log('warn', 'finishMutation: invariant validation threw', {
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { finalPassed, scopeError };
}

// ─── MutationOrchestrator ────────────────────────────────────────────────────

/**
 * Owns the bash/write mutation lifecycle: engine resolution/caching,
 * in-flight mutation bookkeeping (liveMutations), begin/finish mutation,
 * and clearing a mutation when its tool call errors out.
 */
export class MutationOrchestrator {
  private engineCache = new Map<string, StateMachineEngine>();
  // callId → mutationInfo
  private liveMutations = new Map<string, { rootSessionId: string; stageBefore: string }>();
  private logNoop: LogFn;
  private readonly projectDir: string;
  private readonly client?: SessionClient;

  constructor(
    private readonly store: WorkflowStore,
    private readonly queue: SessionQueue,
    projectDir: string | undefined,
    private readonly profilesDir: string,
    log?: LogFn,
    client?: SessionClient | string
  ) {
    // Keep compatibility with the pre-merge constructor where the project
    // directory occupied the final argument.
    this.projectDir = projectDir ?? (typeof client === 'string' ? client : '');
    this.client = typeof client === 'string' ? undefined : client;
    this.logNoop = log ?? (() => Promise.resolve());
  }

  private async log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    await this.logNoop(level, message, extra);
  }

  /**
   * Resolve (lazy-init) an engine for the given profileId.
   */
  async resolveEngine(profileId: string): Promise<StateMachineEngine> {
    const cached = this.engineCache.get(profileId);
    if (cached) {
      return cached;
    }

    const profilesDir = process.env.STATE_MACHINE_PROFILES_DIR ?? this.profilesDir;
    await this.log('info', 'resolveEngine: resolving profile', {
      profileId,
      profilesDir,
      envProfilesDir: process.env.STATE_MACHINE_PROFILES_DIR ?? '(not set)',
    });
    const resolved = await resolveConfig(profileId, profilesDir);

    // Compile before running: a transition to a stage that does not exist, a
    // gate no session carries, or a retry budget belonging to something other
    // than the task are all defects in the file, and a defect in the file
    // should stop the workflow at load rather than one silent guard at a time.
    const engineConfig = mergeSchemasToEngineConfig(resolved.schemas);

    // Compile the merged workflow, not each file: a delta profile names stages
    // its parent declares, and a file read alone would call every one of them
    // unknown. What must hold is the schema the session actually runs.
    const { errors } = compileWorkflow({
      source: resolved.schemas.map((schema) => schema.source).join(' + '),
      stages: engineConfig.stages,
      transitions: engineConfig.transitions,
      stageAssignments: engineConfig.stageAssignments,
    });
    if (errors.length > 0) {
      await this.log('error', 'Profile schema failed to compile', {
        profileId,
        errors: errors.map((error) => `${error.path}: ${error.message}`),
      });
      throw new ProfileConfigurationError(
        profileId,
        resolved.schemas.map((schema) => schema.source).join(' + '),
        errors
      );
    }
    const evaluateGuardFn: EvaluateGuardFn = (
      expression: string,
      session: object,
      guards: Record<string, (...args: unknown[]) => unknown>
    ): boolean => {
      const evaluator = new GuardEvaluator(
        session as Record<string, unknown>,
        guards as Record<string, Function> | undefined,
        {},
        (error, expression) => {
          // A guard that fails to evaluate still blocks the transition, but it
          // is a defect in the schema, not a decision — say so.
          void this.log('warn', 'Guard expression failed to evaluate', {
            profileId,
            expression,
            error: error.message,
          });
        }
      );
      return evaluator.evaluate(expression);
    };
    const engine = new StateMachineEngine(engineConfig, evaluateGuardFn);

    this.engineCache.set(profileId, engine);
    return engine;
  }

  /**
   * Begin a mutation for a bash/write tool call. Guards via canPerformAction,
   * then records the pre-mutation stage in liveMutations for later
   * post-factum transition validation.
   */
  async beginMutation(
    input: { sessionID: string; callID: string },
    output: { args: unknown }
  ): Promise<void> {
    let engine: StateMachineEngine;
    try {
      const preCheck = await this.store.load(input.sessionID);
      if (!preCheck) return;
      engine = await this.resolveEngine(preCheck.profileId);
    } catch (err) {
      await this.log('error', `beginMutation: failed to load session or resolve engine`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new WorkflowBlockedError('Failed to load session or resolve engine');
    }

    // Enqueue the actual mutation work — serialised per root session.
    // beginMutation guards itself internally via canPerformAction,
    // so the early guard here is redundant for safety; the enqueue
    // isolates the concurrent write path.
    await this.queue.enqueue(input.sessionID, async (session) => {
      // No workflow session means the plugin does not govern this call.
      if (!session) return;

      const canMutate = engine.canPerformAction(session, 'beginMutation');
      if (!canMutate.allowed) {
        throw new WorkflowBlockedError(
          `Mutation blocked by engine: ${canMutate.reason ?? 'unknown'}`
        );
      }

      // P1-014: Release interrupted locks — if active operations exist but are
      // NOT tracked in liveMutations, clear them so a new mutation can start.
      // Runs inside enqueue so it operates on the loaded session object.
      this.releaseInterruptedLock(session, input.callID);

      try {
        beginMutation(session, input.callID, 'state-machine');
      } catch (err) {
        await this.log('error', `beginMutation: domain mutation failed`, {
          callID: input.callID,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new WorkflowBlockedError(
          `Mutation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Save stage BEFORE mutation for post-mutation transition validation
      const stageBefore = session.currentStage ?? 'planning';
      this.liveMutations.set(input.callID, { rootSessionId: input.sessionID, stageBefore });
    });
  }

  /**
   * Finish a mutation for a bash/write tool call: compute change scope,
   * run invariant validation, finalise gate via finishMutation, then
   * check for auto-proceed and validate the transition post-factum.
   *
   * Всегда один вызов finishMutation — split/double finalization исключён.
   */
  async finishMutation(
    input: FinishMutationInput,
    onDiagnostics?: (text: string) => void
  ): Promise<void> {
    const mutationInfo = this.liveMutations.get(input.callID);
    this.liveMutations.delete(input.callID);

    await this.queue.enqueue(input.sessionID, async (session) => {
      if (!session) return;

      // Если нет активной мутации для этого callID — ничего не делаем
      if (!session.activeOperations[input.callID]) return;

      // ── Определяем passed из tool metadata ────────────────────────
      const metadataFailed =
        input.metadata && typeof input.metadata === 'object'
          ? !!(input.metadata as Record<string, unknown>)['failed']
          : false;

      // ── 2. Compute scope + invariants через pure function ──────────
      // A missing project directory means scope/invariant collection is not
      // available; do not silently inspect the host repository.
      const scopeRoot = this.projectDir;
      const projectDir = this.projectDir;

      const { finalPassed } = await processScopeAndInvariants({
        session,
        scopeRoot,
        projectDir,
        profilesDir: this.profilesDir,
        metadataFailed,
        log: (level, msg, extra) => this.log(level, msg, extra),
        onDiagnostics,
      });

      // ── 5. Единственный вызов finishMutation ──────────────────────
      domainFinishMutation(session, finalPassed, input.callID);

      // After mutation completes, check for auto-proceed transitions
      try {
        const engine = await this.resolveEngine(session.profileId);
        const transitionResult = engine.tryApplyTransitions(session);
        if (transitionResult.applied) {
          void transitionResult;
        }
      } catch (err) {
        await this.log('warn', `finishMutation: tryApplyTransitions failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Post-factum transition validation: if stage changed, validate the transition
      if (mutationInfo) {
        try {
          const engine = await this.resolveEngine(session.profileId);
          const stageAfter = session.currentStage ?? 'planning';

          if (stageAfter !== mutationInfo.stageBefore) {
            const validation = engine.checkTransition(
              mutationInfo.stageBefore,
              stageAfter,
              session
            );

            if (!validation.allowed) {
              await this.log(
                'warn',
                'finishMutation: stage assignment changed without a direct transition',
                {
                  sessionId: session.sessionId,
                  from: mutationInfo.stageBefore,
                  to: stageAfter,
                  reason: validation.reason,
                }
              );
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Corrupt session')) {
            throw err;
          }
          await this.log('warn', `finishMutation: transition validation failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  }

  /**
   * Применить transitions для сессии. Вызывается из runtime после approve.
   */
  async applyTransitions(session: WorkflowSession): Promise<void> {
    const engine = await this.resolveEngine(session.profileId);
    engine.tryApplyTransitions(session);
  }

  /**
   * Clear a live mutation whose tool call errored out (fired from the
   * event hook). Self-contained: looks up the root session from
   * liveMutations, no caller-supplied rootSessionId needed.
   *
   * P1-014: Also checks if the session's activeOperations contain the
   * errored callId and clears it even when not tracked in liveMutations.
   */
  async clearOnError(callId: string): Promise<void> {
    const mutationInfo = this.liveMutations.get(callId);
    const rootSessionId = mutationInfo?.rootSessionId;

    if (!rootSessionId) {
      // callId not in liveMutations — this can happen when beginMutation
      // succeeded but its `this.liveMutations.set()` was never reached
      // (e.g. the tool call errored before save completed). Only the
      // active session's store entry has the orphaned active operation.
      //
      // We do NOT scan all sessions here: that would be O(n) disk I/O per
      // error event. Instead we rely on P1-014: the next beginMutation for
      // the same session will find and release the interrupted lock via
      // releaseInterruptedLock().
      void this.log(
        'warn',
        `clearOnError: callId not in liveMutations, deferring to next beginMutation`,
        {
          callId,
        }
      );
      return;
    }

    await this.queue.enqueue(rootSessionId, async (session) => {
      if (!session) return;

      clearActiveMutation(session, callId);
      this.liveMutations.delete(callId);
    });
  }

  /**
   * SDK-004: List active sessions from the OpenCode client.
   * Used by dashboard-server to enumerate sessions. Returns empty array
   * when client is unavailable.
   */
  async listSessions(): Promise<Array<{ id: string; title?: string }>> {
    if (!this.client) return [];
    try {
      const result = await this.client.list({});
      // SDK возвращает discriminated union: { data: T; error: undefined } | { data: undefined; error: E }
      if (!('data' in result) || !result.data) return [];
      return result.data.map((s) => ({ id: s.id, title: s.title }));
    } catch (err) {
      void this.log('warn', 'listSessions: client.list failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * P1-014: Release an interrupted lock.
   *
   * If the session has active operations whose callIDs are NOT tracked in
   * this.liveMutations, the mutation is considered dead (interrupted — e.g.,
   * the tool call never reached handleToolAfter, or the process crashed).
   *
   * Also clears expired mutations regardless of tracking status, since
   * finishMutation is guaranteed to complete within MUTATION_TTL_MS.
   */
  private releaseInterruptedLock(
    session: Parameters<typeof isExpiredMutation>[0],
    incomingCallID: string
  ): void {
    const operations = Object.values(session.activeOperations);
    if (operations.length === 0) return;

    // Don't release if the same callID is trying to start — it's a retry
    if (session.activeOperations[incomingCallID]) return;

    for (const operation of operations) {
      // Don't release if we're still tracking it in liveMutations
      if (this.liveMutations.has(operation.callId)) continue;

      // Release if the mutation is expired
      if (isExpiredMutation(session, operation.callId)) {
        clearActiveMutation(session, operation.callId);
        void this.log('info', `Released expired mutation lock`, {
          id: operation.callId,
        });
        continue;
      }

      // Release if the mutation is NOT in liveMutations AND not expired
      // but the callID is unknown — treat as interrupted.
      clearActiveMutation(session, operation.callId);
      void this.log('warn', `Released interrupted mutation lock`, {
        id: operation.callId,
      });
    }
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    this.liveMutations.clear();
    this.engineCache.clear();
  }
}
