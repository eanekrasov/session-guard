import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkflowSession } from '../session/session-schema.ts';
import type { WorkflowStore } from '../session/session-store.ts';
import type { LogFn } from './logger.ts';

/**
 * Ask the host for a session's parent. Returns the parent id, or null when the
 * session is a root, unknown, or the host could not be reached.
 */
export type ResolveParentFn = (_sessionID: string) => Promise<string | null>;

// ─── Transaction ──────────────────────────────────────────────────────────────

/**
 * A scoped handle to a loaded workflow session inside `executor.run()`.
 *
 * The `session` may be `null` — the caller decides what that means (opt-out,
 * creation, no-op). `deferAfterSave` registers a callback that runs only after
 * `WorkflowStore.save()` has succeeded for the outer transaction.
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
 * SessionExecutor — transaction-scoped session lifecycle.
 *
 * Owns root resolution, the per-root promise queue, ALS-based reentrancy, and
 * the load → snapshot → action → compare → conditional save cycle.
 *
 * The run() lifecycle for a top-level (non-reentrant) call:
 *   1. resolve the root session id (parent chain walking)
 *   2. join the per-root promise queue (serialises concurrent outer calls)
 *   3. load the session from the store once
 *   4. JSON.stringify snapshot (pre-action)
 *   5. ALS.run with the loaded session
 *   6. invoke the action
 *   7. compare post-action JSON.stringify to pre-action snapshot
 *   8. call store.save() only when the serialized form changed
 *   9. run deferred effects (only after a successful save)
 *  10. release the queue tail in finally (no return value!)
 *
 * Reentrant calls (same root, same async context) execute inline with the
 * existing transaction — no load, no save, no queue.
 */
export class SessionExecutor {
  /** Per-root-session serialisation queue (key = resolved root session ID). */
  private queues = new Map<string, Promise<void>>();

  /**
   * Active transaction for the current async call context, if any.
   *
   * Async-local, so only a call stack started by an outer `run()` can see it —
   * an unrelated concurrent caller gets no store and queues normally.
   */
  private readonly active = new AsyncLocalStorage<{
    root: string;
    tx: SessionTransaction;
  }>();

  private store: WorkflowStore;
  private log: LogFn;
  private resolveParent?: ResolveParentFn;

  /**
   * Cache: sessionID → resolved root session ID.
   *
   * Every node walked in the parent chain is memoised to its root, so
   * re-entering with any intermediate id produces the same answer without
   * further I/O.
   */
  private readonly parentCache = new Map<string, string>();

  constructor(store: WorkflowStore, log?: LogFn, resolveParent?: ResolveParentFn) {
    this.store = store;
    this.log = log ?? (() => Promise.resolve());
    this.resolveParent = resolveParent;
  }

  /**
   * Run an action inside a session transaction.
   *
   * @param sessionID - The session id to scope the transaction to (resolved to
   *   its root via the parent chain before any I/O).
   * @param action - The action to execute, receiving a `SessionTransaction`
   *   (never null — the session inside the tx may be null when no workflow
   *   session file exists).
   * @returns The action's return value.
   */
  async run<T>(sessionID: string, action: (tx: SessionTransaction) => Promise<T>): Promise<T> {
    const rootSessionId = await this.resolveRoot(sessionID);

    // Reentrant path: this call is nested inside a run() for the same root.
    // Execute inline on the existing transaction — no I/O, no queue.
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

      // Snapshot comparison — conditional save only when the session was
      // mutated (or created from null by the action).
      if (loaded !== null) {
        const after = JSON.stringify(loaded);
        if (after !== snapshot) {
          await this.store.save(loaded);
          // Deferred effects run only after a successful save.
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

    // The stored tail drops itself once it is the last one for this root.
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
   * The root of a session's parent chain — the session the plugin governs.
   */
  async rootOf(sessionID: string): Promise<string> {
    return this.resolveRoot(sessionID);
  }

  /**
   * Clear all per-root promise queues. In-flight calls complete normally, but
   * any future call starts a fresh chain.
   */
  clear(): void {
    this.queues.clear();
  }

  /**
   * Walk the parent chain, cache first and the host for anything it misses.
   *
   * Every node walked is memoised straight to the root, so re-entering with any
   * intermediate id produces the same answer without further I/O. A host that
   * cannot answer leaves the session as its own root.
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
          // A transient host failure is not evidence that this session is a
          // root. Do not memoise the fallback: the next request must retry.
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
