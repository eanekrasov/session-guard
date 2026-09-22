import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkflowSession } from '../session/session-schema.ts';
import type { WorkflowStore } from '../session/session-store.ts';
import type { LogFn } from './logger.ts';

/**
 * Спросить у хоста родителя сессии. Вернуть id родителя или null, когда
 * сессия — корень, неизвестна, или хост недоступен.
 */
export type ResolveParentFn = (_sessionID: string) => Promise<string | null>;

// ─── Transaction ──────────────────────────────────────────────────────────────

/**
 * Скоповый хендл к загруженной workflow сессии внутри `executor.run()`.
 *
 * `session` может быть `null` — вызывающий код решает, что это значит
 * (opt-out, создание, no-op). `deferAfterSave` регистрирует колбэк, который
 * запускается только после того, как `WorkflowStore.save()` успешно завершился
 * для внешней транзакции.
 */
export interface SessionTransaction {
  /** The loaded workflow session, or `null` when none exists (creation path). */
  readonly session: WorkflowSession | null;

  /**
   * Register a side-effect to run after the enclosing `WorkflowStore.save()`
   * has persisted. Does NOT run if save is skipped (read-only) or fails.
   */
  deferAfterSave(fn: () => Promise<void>): void;
}

// ─── SessionExecutor ──────────────────────────────────────────────────────────

/**
 * SessionExecutor — жизненный цикл сессии в скоупе транзакции.
 *
 * Владет резолвингом корня, очередью промисов на корень, реенрантностью на
 * ALS, и циклом load → snapshot → action → compare → условный save.
 *
 * Жизненный цикл run() для top-level (не-реенрантного) вызова:
 *   1. резолвить root session id (ходьба по цепочке родителей)
 *   2. встать в очередь промисов на корень (сериализует конкурентные outer вызовы)
 *   3. загрузить сессию из стора один раз
 *   4. JSON.stringify snapshot (pre-action)
 *   5. ALS.run с загруженной сессией
 *   6. вызвать action
 *   7. сравнить post-action JSON.stringify с pre-action snapshot
 *   8. вызвать store.save() только когда сериализованная форма изменилась
 *   9. запустить deferred эффекты (только после успешного save)
 *  10. отпустить хвост очереди в finally (нет возвращаемого значения!)
 *
 * Реенрантные вызовы (тот же корень, тот же async контекст) выполняются
 * инлайн в существующей транзакции — нет load, нет save, нет очереди.
 */
export class SessionExecutor {
  /** Очередь сериализации на root-сессию (ключ = резолвленный root session ID). */
  private queues = new Map<string, Promise<void>>();

  /**
   * Активная транзакция для текущего async call контекста, если есть.
   *
   * Async-local, поэтому видит её только стек вызовов, начатый outer `run()` —
   * неподвязанный конкурентный вызывающий код не получает стор и встаёт в очередь
   * нормально.
   */
  private readonly active = new AsyncLocalStorage<{
    root: string;
    tx: SessionTransaction;
  }>();

  private store: WorkflowStore;
  private log: LogFn;
  private resolveParent?: ResolveParentFn;

  /**
   * Кэш: sessionID → резолвленный root session ID.
   *
   * Каждый пройденный узел в цепочке родителей мемоизируется сразу в корень,
   * поэтому повторный вход с любым промежуточным id даёт тот же ответ без
   * дополнительного I/O.
   */
  private readonly parentCache = new Map<string, string>();

  constructor(store: WorkflowStore, log?: LogFn, resolveParent?: ResolveParentFn) {
    this.store = store;
    this.log = log ?? (() => Promise.resolve());
    this.resolveParent = resolveParent;
  }

  /**
   * Запустить action внутри транзакции сессии.
   *
   * @param sessionID - id сессии для скоупа транзакции (резолвится к её корню
   *   через цепочку родителей до любого I/O).
   * @param action - action для выполнения, получает `SessionTransaction`
   *   (никогда не null — сессия внутри tx может быть null, когда файла workflow
   *   сессии не существует).
   * @returns Возвращаемое значение action.
   */
  async run<T>(sessionID: string, action: (tx: SessionTransaction) => Promise<T>): Promise<T> {
    const rootSessionId = await this.resolveRoot(sessionID);

    // Reentrant path: этот вызов вложен в run() для того же корня.
    // Выполнить инлайн в существующей транзакции — нет I/O, нет очереди.
    const current = this.active.getStore();
    if (current && current.root === rootSessionId) {
      return action(current.tx);
    }

    const prev = this.queues.get(rootSessionId) ?? Promise.resolve();
    const currentPromise: Promise<T> = prev.then(async () => {
      const loaded = await this.store.load(rootSessionId);
      const snapshot = loaded !== null ? JSON.stringify(loaded) : null;

      const deferredFns: Array<() => Promise<void>> = [];

      const tx: SessionTransaction = {
        get session(): WorkflowSession | null {
          return loaded;
        },
        deferAfterSave(fn: () => Promise<void>): void {
          deferredFns.push(fn);
        },
      };

      const result = await this.active.run({ root: rootSessionId, tx }, () => action(tx));

      // Сравнение снимков — условный save только когда сессия мутировала
      // (или была создана из null action'ом).
      if (loaded !== null) {
        const after = JSON.stringify(loaded);
        if (after !== snapshot) {
          await this.store.save(loaded);
          // Отложенные эффекты запускаются только после успешного save.
          for (const fn of deferredFns) {
            await fn();
          }
        }
      }

      const saved = loaded !== null && JSON.stringify(loaded) !== snapshot;
      void this.log('debug', `SessionExecutor run for root ${rootSessionId}`, {
        sessionID,
        hasSession: loaded !== null,
        saved,
      });

      return result;
    });

    // Хвост очереди сам удаляется, когда становится последним для этого корня.
    const tail: Promise<void> = currentPromise
      .catch((err) => {
        this.log('error', `SessionExecutor action failed for root ${rootSessionId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .then(() => {
        if (this.queues.get(rootSessionId) === tail) this.queues.delete(rootSessionId);
      });
    this.queues.set(rootSessionId, tail);

    return currentPromise;
  }

  /**
   * Корень цепочки родителей сессии — сессия, которой плагин управляет.
   */
  async rootOf(sessionID: string): Promise<string> {
    return this.resolveRoot(sessionID);
  }

  /**
   * Очистить все очереди промисов на корень. In-flight вызовы завершаются
   * нормально, но любой будущий вызов начинает новую цепочку.
   */
  clear(): void {
    this.queues.clear();
  }

  /**
   * Пройти цепочку родителей, кэш сначала и хост для всего, что он пропустил.
   *
   * Каждый пройденный узел мемоизируется сразу в корень, поэтому повторный вход
   * с любым промежуточным id даёт тот же ответ без дополнительного I/O. Хост,
   * который не может ответить, оставляет сессию своим собственным корнем.
   */
  private async resolveRoot(sessionID: string): Promise<string> {
    const walked: string[] = [];
    let current = sessionID;
    const visited = new Set<string>();

    while (current && !visited.has(current)) {
      visited.add(current);
      walked.push(current);

      let parentID = this.parentCache.get(current);
      if (parentID === undefined && this.resolveParent) {
        try {
          parentID = (await this.resolveParent(current)) ?? current;
        } catch (err) {
          void this.log('debug', `SessionExecutor: parent lookup failed for ${current}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // Временный фейл хоста не является доказательством, что эта сессия — корень.
          // Не мемоизировать фоллбек: следующий запрос должен повторить попытку.
          return sessionID;
        }
        this.parentCache.set(current, parentID);
      }

      if (!parentID || parentID === current) break;
      current = parentID;
    }

    for (const node of walked) this.parentCache.set(node, current);
    return current;
  }
}
