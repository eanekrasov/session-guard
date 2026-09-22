import { resolve, join } from 'node:path';
import type { WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';
import { findTask } from '../session/helpers.ts';
import { SessionGuardEngine, type EvaluateGuardFn, type EngineConfig } from '../domain/engine.ts';
import { resolveConfig } from '../public-api.ts';
import { compileWorkflow } from '../schema/compile-workflow.ts';
import { mergeStages } from '../schema/schema-loader.ts';
import { ProfileConfigurationError, firstNestedStageId } from '../schema/types.ts';
import { GuardEvaluator, type GuardEvaluationContext } from '../schema/guard-evaluator.ts';
import type { GuardEvaluationSession } from '../domain/session-facts.ts';
import type { ResolvedSchema } from '../schema/types.ts';
import { SessionExecutor } from './session-executor.ts';
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
 * Проецировать одну резолвленную схему на конфиг движка.
 *
 * Сессия запускает **одну** схему. Схемы комбинируются только через `extends`, и
 * этот комбининг уже случился к моменту существования `ResolvedSchema`
 * (`ProfileResolver.resolveSingleSchema`), так что тут нечего мержить.
 *
 * Раньше это сводило весь список схем профиля в один конфиг. Стадии
 * выживали только потому что их ключи отличаются; `gates`,
 * `taskControlAgents` и переходы с одинаковым эндпоинтом были
 * silently last-wins, так что два независимых workflow в одном профиле
 * бы тихо стали одним. Ни один профиль не объявлял два, так что это никогда
 * не проявлялось.
 */
export function schemaToEngineConfig(schema: ResolvedSchema): EngineConfig {
  const stages = (mergeStages({}, schema.stages) ?? {}) as NonNullable<EngineConfig['stages']>;

  return {
    stages: Object.keys(stages).length > 0 ? stages : undefined,
    stageAssignments: [...(schema.stageAssignments ?? [])],
    transitions: [...(schema.transitions ?? [])],
    taskControlAgents: schema.taskControlAgents ? [...schema.taskControlAgents] : undefined,
    editingAgents: schema.editingAgents ? [...schema.editingAgents] : undefined,
  };
}

/**
 * Выбрать схему, которую запускает сессия, из списка профиля.
 *
 * Голый profile id — без названной схемы — легален только пока профиль держит
 * ровно одну схему. С несколькими выбор — за вызывающим кодом, и угадывание
 * тут — как один workflow тихо становится другим.
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
   * Собственный базовый фрейм хода (`captureBaseline`, взятый в
   * `beginMutation`), диффнутый через `computeChangeScope`. `undefined` значит
   * фрейм для этого хода не захватывался (D5) — скоуп не вычисляется, и пустой
   * базовый фрейм никогда не подставляется вместо настоящего.
   */
  frame?: BaselineHashes;
}

/**
 * Чистая функция: вычислить скоуп → запустить валидацию инвариантов → определить
 * finalPassed.
 *
 * Вынесена из MutationOrchestrator.finishMutation для тестируемости.
 * НЕ трогает сессию стор и очередь — только мутирует session.changedFiles
 * и возвращает решение pass/fail и любой диагностический текст.
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

  // Два разных списка, и смешение их — дефект в любом направлении.
  //
  // `sorted` — это скоуп ЭТОГО хода. Каждый вердикт ниже про этот ход —
  // писал ли он за пределами writeScope своей задачи, и удовлетворяют ли файлы,
  // которые он тронул, инварианты — поэтому судить его против чего-то более
  // широкого осуждает ход за то, что сделал более ранний.
  //
  // `session.changedFiles` — это то, что delivery permit ожидает в коммите:
  // то, что работа произвела, собранное по одному ходу за раз. Оно аккумулируется
  // — и затем причесывается до того, что всё ещё отличается от HEAD, потому что
  // файл, отредактированный одним ходом и возвращённый следующим, работой не
  // изменён вовсе. Оставленный в списке он заставлял permit ожидать файл, чего
  // коммит не мог содержать, и правильный коммит отвергался.
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
 * Владение lifecycle мутации bash/write: резолвинг/кэширование движка,
 * букипинг in-flight мутаций (liveMutations), begin/finish mutation,
 * и очистка мутации когда вызов инструмента фейлит с ошибкой.
 */
export class MutationOrchestrator {
  private engineCache = new Map<string, SessionGuardEngine>();
  // callId → mutationInfo
  private liveMutations = new Map<string, { rootSessionId: string; stageBefore: string }>();
  private logNoop: LogFn;
  private readonly projectDir: string;
  private readonly client?: SessionClient;

  constructor(
    private readonly store: WorkflowStore,
    private readonly executor: SessionExecutor,
    projectDir: string | undefined,
    private readonly profilesDir: string,
    log?: LogFn,
    client?: SessionClient | string
  ) {
    // Сохранить совместимость с pre-merge конструктором, где директория проекта
    // занимала последний аргумент.
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
   * Резолвить (lazy-init) движок для данного profileId.
   */
  async resolveEngine(profileId: string, schemaId?: string): Promise<SessionGuardEngine> {
    // Движок зависит от директории не меньше чем от id, и директория читается из
    // окружения на каждом вызове. Ключ только по id возвращает движок первой
    // директории для всех последующих — чего продакшн не замечает, потому что
    // его директория не двигается, и тестовый сьют, направляющий тот же profile
    // id на две фикстурные директории, тоже не замечает: он просто молча
    // получает первый.
    const profilesDir = process.env.SESSION_GUARD_PROFILES_DIR ?? this.profilesDir;
    const cacheKey = `${profilesDir}\u0000${profileId}\u0000${schemaId ?? ''}`;
    const cached = this.engineCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    await this.log('info', 'resolveEngine: resolving profile', {
      profileId,
      profilesDir,
      envProfilesDir: process.env.SESSION_GUARD_PROFILES_DIR ?? '(not set)',
    });
    const resolved = await resolveConfig(profileId, profilesDir);

    // Скомпилировать перед запуском: переход в стадию, которой нет, гейт,
    // который ни одна сессия не несет, или бюджет ретрая, принадлежащий чему-то
    // другому кроме задачи — всё это дефекты в файле, и дефект в файле должен
    // остановить workflow при загрузке, а не по одному тихому гарду за раз.
    const schema = selectSchema(profileId, resolved.schemas, schemaId);
    const engineConfig = schemaToEngineConfig(schema);

    // Скомпилировать схему, которую сессия реально запускает, после того как её
    // цепочка `extends` свёрнута: дельта-схема называет стадии, которые
    // декларирует родитель, и чтение только файла дельты назвало бы каждый из
    // них неизвестным.
    const { errors } = compileWorkflow({
      id: schema.id,
      source: schema.source,
      stages: engineConfig.stages,
      transitions: engineConfig.transitions,
      stageAssignments: engineConfig.stageAssignments,
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
      session: GuardEvaluationSession,
      guards: Record<string, (...args: unknown[]) => unknown>,
      // Дропалось на пол раньше, заменялось на `{}`. Оно несёт
      // `currentLoopListKey`, которым `allTasksCompleted()` без аргумента знает,
      // о каком списке его спрашивают — так что один и тот же гард отвечал
      // `true` оценённым напрямую и `false` через движок, и переходы, которые
      // должны были сработать, не срабатывали.
      evaluationContext?: GuardEvaluationContext
    ): boolean => {
      const evaluator = new GuardEvaluator(
        session,
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
    const engine = new SessionGuardEngine(engineConfig, evaluateGuardFn);

    this.engineCache.set(cacheKey, engine);
    return engine;
  }

  /**
   * Начать ход для вызова bash/write: снять baseline-кадр и записать стадию
   * до хода в liveMutations для последующей проверки перехода постфактум.
   *
   * Проверки `canPerformAction(session, 'beginMutation')` здесь больше нет —
   * `actionGuards` удалён. Это был единственный запрет правок до утверждения
   * плана, и теперь его несёт `actions:` стадии: запись `edit` с guard-ом
   * `session.approved('plan')`.
   */
  async beginMutation(
    input: { sessionID: string; callID: string },
    output: { args: unknown }
  ): Promise<void> {
    let engine: SessionGuardEngine;
    try {
      // The hook's id may be a dispatched subagent's; the workflow session is
      // the root's. Loading by the raw id found nothing and the mutation went
      // ungoverned.
      const preCheck = await this.store.load(await this.executor.rootOf(input.sessionID));
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

    // Запустить реальную работу мутации внутри транзакции исполнителя — сериализованной
    // на корневую сессию с циклом load/save.
    await this.executor.run(input.sessionID, async (tx) => {
      // Нет сессии workflow — плагин не управляет этим вызовом.
      if (!tx.session) return;

      // P1-014: Release interrupted locks — if active operations exist but are
      // NOT tracked in liveMutations, clear them so a new mutation can start.
      // Runs inside executor.run so it operates on the loaded session object.
      this.releaseInterruptedLock(tx.session, input.callID);

      try {
        // Список цикла текущей стадии — или `null`, если стадия не цикл.
        // Без него синтез прогона искал единственную runnable-задачу по всем
        // спискам сразу и в схеме с двумя последовательными циклами мог взять
        // задачу чужого.
        const stageDef = engine.getStages()[tx.session.currentStage];
        beginMutation(
          tx.session,
          input.callID,
          'session-guard',
          (listKey) => {
            const loopStage = engine.getLoopStage(listKey);
            return loopStage ? (firstNestedStageId(loopStage) ?? null) : null;
          },
          stageDef?.loop ?? null,
          new Date().toISOString()
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
      const operation = tx.session.activeOperations[input.callID];
      if (operation) operation.baseline = frame;

      // Сохранить стадию ДО мутации для постфактум валидации перехода.
      // `currentStage` всегда установлен — `workflow-create` пишет первую
      // стадию скомпилированного workflow — так что фоллбека нет, и
      // базовый профиля `planning` был бы неправильным в любом случае.
      const stageBefore = tx.session.currentStage;
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

    await this.executor.run(input.sessionID, async (tx) => {
      if (!tx.session) return;

      // Если нет активной мутации для этого callID — ничего не делаем
      if (!tx.session.activeOperations[input.callID]) return;

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
      const frame = tx.session.activeOperations[input.callID]?.baseline;

      const { finalPassed } = await processScopeAndInvariants({
        session: tx.session,
        scopeRoot,
        frame,
        projectDir,
        profilesDir: this.profilesDir,
        metadataFailed,
        log: (level, msg, extra) => this.log(level, msg, extra),
        onDiagnostics,
      });

      // ── 5. Единственный вызов finishMutation ──────────────────────
      domainFinishMutation(tx.session, finalPassed, input.callID);

      // После завершения мутации проверить auto-proceed переходы
      try {
        const engine = await this.resolveEngine(tx.session.profileId, tx.session.schemaId);
        const transitionResult = engine.tryApplyTransitions(tx.session);
        if (transitionResult.applied) {
          void transitionResult;
        }
      } catch (err) {
        await this.log('warn', `finishMutation: tryApplyTransitions failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Post-factum валидация перехода: если стадия изменилась, валидировать переход
      if (mutationInfo) {
        try {
          const engine = await this.resolveEngine(tx.session.profileId, tx.session.schemaId);
          const stageAfter = tx.session.currentStage;

          if (stageAfter !== mutationInfo.stageBefore) {
            const validation = engine.checkTransition(
              mutationInfo.stageBefore,
              stageAfter,
              tx.session
            );

            if (!validation.allowed) {
              await this.log(
                'warn',
                'finishMutation: stage assignment changed without a direct transition',
                {
                  sessionId: tx.session.sessionId,
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
  async applyTransitions(
    session: WorkflowSession
  ): Promise<{ applied: boolean; from?: string; to?: string; guard?: string | null }> {
    const engine = await this.resolveEngine(session.profileId, session.schemaId);
    const result = engine.tryApplyTransitions(session);
    return {
      applied: result.applied === true,
      from: result.from,
      to: result.to,
      guard: result.guard ?? null,
    };
  }

  /**
   * Очистить живую мутацию, чей вызов инструмента ошибся (вызывается из
   * event hook). Самодостаточная: ищет корневую сессию из
   * liveMutations, caller-supplied rootSessionId не нужен.
   *
   * P1-014: Также проверяет, содержат ли activeOperations сессии ошибочный
   * callId и очищает его даже когда не отслеживается в liveMutations.
   */
  async clearOnError(callId: string): Promise<void> {
    const mutationInfo = this.liveMutations.get(callId);
    const rootSessionId = mutationInfo?.rootSessionId;

    if (!rootSessionId) {
      // callId not in liveMutations — может случиться, когда beginMutation
      // прошло успешно, но `this.liveMutations.set()` не дожило до вызова
      // (например, вызов инструмента упал до завершения save). Только
      // запись активной сессии в сторе имеет orphaned active operation.
      //
      // Мы НЕ сканируем все сессии здесь: это O(n) дисковый I/O на каждый
      // error event. Вместо этого полагаемся на P1-014: следующий
      // beginMutation для той же сессии найдёт и освободит прерванный лок
      // через releaseInterruptedLock().
      void this.log(
        'warn',
        `clearOnError: callId not in liveMutations, deferring to next beginMutation`,
        {
          callId,
        }
      );
      return;
    }

    await this.executor.run(rootSessionId, async (tx) => {
      if (!tx.session) return;

      clearActiveMutation(tx.session, callId);
      this.liveMutations.delete(callId);
    });
  }

  /**
   * SDK-004: Список активных сессий из OpenCode клиента.
   * Используется dashboard-server для перечисления сессий. Возвращает
   * пустой массив когда клиент недоступен.
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
   * P1-014: Освободить прерванный лок.
   *
   * Если у сессии есть активные операции, чьи callIDs НЕ отслеживаются в
   * this.liveMutations, мутация считается мёртвой (прерванной — например,
   * вызов инструмента никогда не достиг handleToolAfter, или процесс упал).
   *
   * Также очищает истёкшие мутации независимо от статуса отслеживания, так как
   * finishMutation гарантированно завершается в пределах MUTATION_TTL_MS.
   */
  private releaseInterruptedLock(
    session: Parameters<typeof isExpiredMutation>[0],
    incomingCallID: string
  ): void {
    const operations = Object.values(session.activeOperations);
    if (operations.length === 0) return;

    // Не отпускать если тот же callID пытается начать — это ретрай
    if (session.activeOperations[incomingCallID]) return;

    for (const operation of operations) {
      // Не отпускать если мы его всё ещё отслеживаем в liveMutations
      if (this.liveMutations.has(operation.callId)) continue;

      // Диспатченный `task` никогда не регистрируется в liveMutations, поэтому
      // отсутствие в мапе ничего не доказывает о нём. Освобождение удаляло
      // запущенную task-операцию и заменяло её на write — у результата задачи
      // тогда не было чему атрибутироваться и её прогон застрял.
      // Только истечение ниже может закончить task-вызов.
      if (operation.kind === 'task' && !isExpiredMutation(session, operation.callId)) continue;

      // Освободить если мутация истекла
      if (isExpiredMutation(session, operation.callId)) {
        clearActiveMutation(session, operation.callId);
        void this.log('info', `Released expired mutation lock`, {
          id: operation.callId,
        });
        continue;
      }

      // Освободить если мутация НЕ в liveMutations И не истекла
      // но callID неизвестен — считать прерванной.
      clearActiveMutation(session, operation.callId);
      void this.log('warn', `Released interrupted mutation lock`, {
        id: operation.callId,
      });
    }
  }

  /**
   * Очистить все ресурсы.
   */
  dispose(): void {
    this.liveMutations.clear();
    this.engineCache.clear();
  }
}
