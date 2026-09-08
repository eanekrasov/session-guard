import { resolve, join } from 'node:path';
import type { WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';
import { findTask } from '../session/helpers.ts';
import { StateMachineEngine, type EvaluateGuardFn, type EngineConfig } from '../domain/engine.ts';
import { resolveConfig } from '../public-api.ts';
import { compileWorkflow } from '../schema/compile-workflow.ts';
import { mergeStages } from '../schema/schema-loader.ts';
import { ProfileConfigurationError, firstNestedStageId } from '../schema/types.ts';
import { GuardEvaluator, type GuardEvaluationContext } from '../schema/guard-evaluator.ts';
import type { ResolvedSchema } from '../schema/types.ts';
import { SessionQueue } from './session-queue.ts';
import { WorkflowBlockedError } from './blocked-error.ts';
import {
  captureBaseline,
  changedAgainstHead,
  computeChangeScope,
  type BaselineHashes,
} from './change-scope.ts';
import { matchesScope } from './scope-match.ts';
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

// ─── Pure helper: ResolvedSchema → EngineConfig ───────────────────────────

/**
 * Project one resolved schema onto the engine's configuration.
 *
 * A session runs **one** schema. Schemas combine only through `extends`, and
 * that combining has already happened by the time a `ResolvedSchema` exists
 * (`ProfileResolver.resolveSingleSchema`), so there is nothing left to merge
 * here.
 *
 * This used to fold a profile's whole schema list into one config. Stages
 * survived that only because their keys differ; `gates`,
 * `taskControlAgents` and same-endpoint transitions were
 * silently last-wins, so two independent workflows in one profile would have
 * quietly become one. No profile declared two, so it never bit.
 */
export function schemaToEngineConfig(schema: ResolvedSchema): EngineConfig {
  const stages = (mergeStages({}, schema.stages) ?? {}) as NonNullable<EngineConfig['stages']>;

  return {
    stages: Object.keys(stages).length > 0 ? stages : undefined,
    stageAssignments: [...(schema.stageAssignments ?? [])],
    transitions: [...(schema.transitions ?? [])],
    gates: schema.gates?.map((gate) => ({ ...gate })),
    taskControlAgents: schema.taskControlAgents ? [...schema.taskControlAgents] : undefined,
    editingAgents: schema.editingAgents ? [...schema.editingAgents] : undefined,
  };
}

/**
 * Pick the schema a session runs out of the profile's list.
 *
 * A bare profile id — no schema named — is legal only while the profile holds
 * exactly one schema. With several, the choice is the caller's to make, and
 * guessing at it is how one workflow silently becomes another.
 */
export function selectSchema(
  profileId: string,
  schemas: ResolvedSchema[],
  wanted: string | undefined
): ResolvedSchema {
  if (wanted !== undefined) {
    const found = schemas.find((schema) => schema.id === wanted);
    if (!found) {
      throw new Error(
        `Profile "${profileId}" has no schema "${wanted}". Available: ${
          schemas.map((schema) => schema.id).join(', ') || '(none)'
        }`
      );
    }
    return found;
  }

  if (schemas.length === 1) return schemas[0]!;
  if (schemas.length === 0) {
    throw new Error(`Profile "${profileId}" declares no schema to run`);
  }
  throw new Error(
    `Profile "${profileId}" holds several schemas, so one must be named as ${profileId}/<schemaId>. Available: ${schemas
      .map((schema) => schema.id)
      .join(', ')}`
  );
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
  /**
   * The move's own baseline frame (`captureBaseline`, taken in
   * `beginMutation`), diffed via `computeChangeScope`. `undefined` means no
   * frame was captured for this move (D5) — the scope is not computed, and
   * no empty baseline is ever substituted for a real one.
   */
  frame?: BaselineHashes;
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
  const { session, scopeRoot, projectDir, profilesDir, metadataFailed, log, onDiagnostics, frame } =
    input;

  let changedFiles: string[] = [];
  let scopeError: string | null = null;

  if (scopeRoot && frame) {
    try {
      changedFiles = await computeChangeScope(scopeRoot, frame);
    } catch (err) {
      scopeError = err instanceof Error ? err.message : String(err);
      changedFiles = [];
      onDiagnostics?.(`\n\n[workflow-scope-error]\nChange scope computation failed: ${scopeError}`);
    }
  } else if (scopeRoot && !frame) {
    await log('warn', 'processScopeAndInvariants: no baseline frame for this move', {
      sessionId: session.sessionId,
    });
  }

  // Two different lists, and conflating them is a defect in either direction.
  //
  // `sorted` is THIS move's scope. Every verdict below is about this move —
  // whether it wrote outside its task's writeScope, and whether the files it
  // touched satisfy the invariants — so judging it against anything wider
  // convicts a move of what an earlier one did.
  //
  // `session.changedFiles` is what the delivery permit expects the commit to
  // carry: what the work produced, gathered one move at a time. It accumulates
  // — and is then pruned to what still differs from HEAD, because a file
  // edited by one move and put back by the next has not been changed by the
  // work at all. Left on the list it made the permit expect a file the commit
  // could not contain, and a correct commit was refused.
  const sorted = [...changedFiles].sort();
  const accumulated = new Set([...(session.changedFiles ?? []), ...sorted]);
  session.changedFiles = scopeRoot
    ? changedAgainstHead(scopeRoot)
        .filter((file) => accumulated.has(file))
        .sort()
    : [...accumulated].sort();

  let finalPassed = !metadataFailed;

  const operation = Object.values(session.activeOperations).find(
    (candidate) => candidate.baseline === frame
  );
  const task = operation ? findTask(session, operation.taskId) : undefined;
  const outOfScope = task?.writeScope?.length
    ? sorted.filter((file) => !matchesScope(file, task.writeScope!))
    : [];
  if (outOfScope.length > 0) {
    finalPassed = false;
    await log('warn', 'finishMutation: task changed files outside writeScope', {
      sessionId: session.sessionId,
      taskId: task?.id,
      files: outOfScope,
    });
    onDiagnostics?.(
      `\n\n[workflow-scope-violation]\nChanged files outside writeScope: ${outOfScope.join(', ')}`
    );
  }

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
  async resolveEngine(profileId: string, schemaId?: string): Promise<StateMachineEngine> {
    // The engine depends on the directory as much as on the id, and the
    // directory is read from the environment on every call. Keying on the id
    // alone returns the first directory's engine for every later one — which
    // production never notices, because its directory does not move, and a
    // test suite that points the same profile id at two fixture directories
    // does not notice either: it just silently gets the first.
    const profilesDir = process.env.STATE_MACHINE_PROFILES_DIR ?? this.profilesDir;
    const cacheKey = `${profilesDir}\u0000${profileId}\u0000${schemaId ?? ''}`;
    const cached = this.engineCache.get(cacheKey);
    if (cached) {
      return cached;
    }

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
    const schema = selectSchema(profileId, resolved.schemas, schemaId);
    const engineConfig = schemaToEngineConfig(schema);

    // Compile the schema the session actually runs, after its `extends` chain
    // has been folded in: a delta schema names stages its parent declares, and
    // reading the delta's own file alone would call every one of them unknown.
    const { errors } = compileWorkflow({
      id: schema.id,
      source: schema.source,
      stages: engineConfig.stages,
      transitions: engineConfig.transitions,
      stageAssignments: engineConfig.stageAssignments,
      // Without this the compiler has no declaration to check a stage's
      // `gates:` against, so the check turns itself off instead of failing.
      gates: engineConfig.gates,
    });
    if (errors.length > 0) {
      await this.log('error', 'Profile schema failed to compile', {
        profileId,
        schemaId: schema.id,
        errors: errors.map((error) => `${error.path}: ${error.message}`),
      });
      throw new ProfileConfigurationError(profileId, schema.source, errors);
    }
    const evaluateGuardFn: EvaluateGuardFn = (
      expression: string,
      session: object,
      guards: Record<string, (...args: unknown[]) => unknown>,
      // Dropped on the floor before, replaced with `{}`. It carries
      // `currentLoopListKey`, which is how `allTasksCompleted()` with no
      // argument knows which list it is being asked about — so the same guard
      // answered `true` evaluated directly and `false` through the engine, and
      // transitions that should have fired did not.
      evaluationContext?: GuardEvaluationContext
    ): boolean => {
      const evaluator = new GuardEvaluator(
        session as Record<string, unknown>,
        guards as Record<string, Function> | undefined,
        evaluationContext ?? {},
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

    this.engineCache.set(cacheKey, engine);
    return engine;
  }

  /**
   * Начать ход для вызова bash/write: снять baseline-кадр и записать стадию
   * до хода в liveMutations для последующей проверки перехода постфактум.
   *
   * Проверки `canPerformAction(session, 'beginMutation')` здесь больше нет —
   * `actionGuards` удалён. Это был единственный запрет правок до утверждения
   * плана. См. docs/gate-actions-before-removal.md.
   */
  async beginMutation(
    input: { sessionID: string; callID: string },
    output: { args: unknown }
  ): Promise<void> {
    let engine: StateMachineEngine;
    try {
      // The hook's id may be a dispatched subagent's; the workflow session is
      // the root's. Loading by the raw id found nothing and the mutation went
      // ungoverned.
      const preCheck = await this.store.load(await this.queue.rootOf(input.sessionID));
      if (!preCheck) return;
      engine = await this.resolveEngine(preCheck.profileId, preCheck.schemaId);
    } catch (err) {
      await this.log('error', `beginMutation: failed to load session or resolve engine`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new WorkflowBlockedError('Failed to load session or resolve engine');
    }

    // Captured before the queue, like a task's own baseline (D2): real I/O
    // (git status + a hash per dirty path) that must not run inside the
    // serialised session queue. A missing projectDir leaves this move
    // without a frame — handled at finish time (D5), never a false `{}`.
    // `captureBaseline` shells out to git and throws outside a git working
    // tree. A missing frame is D5's "no frame" case, not a reason to fail
    // the mutating call about to run.
    let frame: BaselineHashes | undefined;
    if (this.projectDir) {
      try {
        frame = await captureBaseline(this.projectDir);
      } catch (err) {
        await this.log(
          'warn',
          'beginMutation: captureBaseline failed — proceeding without a frame',
          {
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }

    // Enqueue the actual mutation work — serialised per root session: the
    // enqueue isolates the concurrent write path.
    await this.queue.enqueue(input.sessionID, async (session) => {
      // No workflow session means the plugin does not govern this call.
      if (!session) return;

      // P1-014: Release interrupted locks — if active operations exist but are
      // NOT tracked in liveMutations, clear them so a new mutation can start.
      // Runs inside enqueue so it operates on the loaded session object.
      this.releaseInterruptedLock(session, input.callID);

      try {
        // Список цикла текущей стадии — или `null`, если стадия не цикл.
        // Без него синтез прогона искал единственную runnable-задачу по всем
        // спискам сразу и в схеме с двумя последовательными циклами мог взять
        // задачу чужого.
        const stageDef = engine.getStages()[session.currentStage];
        beginMutation(
          session,
          input.callID,
          'state-machine',
          (listKey) => {
            const loopStage = engine.getLoopStage(listKey);
            return loopStage ? (firstNestedStageId(loopStage) ?? null) : null;
          },
          stageDef?.loop ?? null
        );
      } catch (err) {
        await this.log('error', `beginMutation: domain mutation failed`, {
          callID: input.callID,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new WorkflowBlockedError(
          `Mutation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const operation = session.activeOperations[input.callID];
      if (operation) operation.baseline = frame;

      // Save stage BEFORE mutation for post-mutation transition validation.
      // `currentStage` is always set — `workflow-create` writes the compiled
      // workflow's own first stage — so there is nothing to fall back to, and
      // the base profile's `planning` would have been the wrong thing anyway.
      const stageBefore = session.currentStage;
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
      const frame = session.activeOperations[input.callID]?.baseline;

      const { finalPassed } = await processScopeAndInvariants({
        session,
        scopeRoot,
        frame,
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
        const engine = await this.resolveEngine(session.profileId, session.schemaId);
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
          const engine = await this.resolveEngine(session.profileId, session.schemaId);
          const stageAfter = session.currentStage;

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
  /**
   * Возвращает, был ли переход применён и куда. Раньше результат выбрасывался,
   * и вызывающий не мог отличить «сессия сдвинулась» от «осталась на месте» —
   * а это разные события, и второе происходит после каждого второго вызова
   * инструмента.
   */
  async applyTransitions(session: WorkflowSession): Promise<{ applied: boolean; to?: string }> {
    const engine = await this.resolveEngine(session.profileId, session.schemaId);
    const result = engine.tryApplyTransitions(session);
    return { applied: result.applied === true, to: result.to };
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

      // A dispatched `task` is never registered in liveMutations, so absence
      // from that map proves nothing about it. Releasing one deleted a running
      // task's operation and replaced it with the write — the task's own
      // result then had nothing to attribute itself to and its run stayed put.
      // Only the expiry below may end a task call.
      if (operation.kind === 'task' && !isExpiredMutation(session, operation.callId)) continue;

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
