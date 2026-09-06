import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';
import type { LogFn } from './logger.ts';

/**
 * SessionQueue — per-root-session serialized execution queue.
 *
 * All actions for the same root session (resolved by walking parentID chain)
 * are serialized via a single promise chain. Root-session resolution reads
 * from `store.parentCache`, which is populated on every session save.
 *
 * Supports reentrant calls: if an enqueued action calls enqueue() again for
 * the same root session ID, the nested call executes inline on the session the
 * outer execution already holds, and the outer save persists both writes.
 *
 * Reentrancy is decided by async call context, not by a flag keyed on the root
 * id: a second top-level call that merely overlaps in time is not reentrant and
 * must queue behind the first, or the two would race on the same session.
 */
export class SessionQueue {
  /** Per-root-session serialisation queue (key = resolved root session ID). */
  private queues = new Map<string, Promise<void>>();

  /**
   * The execution a call is running inside, if any.
   *
   * Async-local, so only the call stack started by an action can see it — an
   * unrelated concurrent caller gets no store and queues normally.
   */
  private readonly active = new AsyncLocalStorage<{
    root: string;
    session: WorkflowSession | null;
  }>();

  private store: WorkflowStore;
  private log: LogFn;

  constructor(store: WorkflowStore, log?: LogFn) {
    this.store = store;
    this.log = log ?? (() => Promise.resolve());
  }

  /**
   * Enqueue an action for a session. Resolves the root session ID synchronously
   * via the store's parent cache.
   *
   * If the caller is already inside a queue execution for the same root session
   * (reentrant call), the action runs inline on the previously loaded session.
   * Otherwise it chains on the root's promise chain.
   *
   * Error from one action is swallowed in the stored chain so subsequent
   * actions for the same root still run, but the original caller still
   * receives the rejection.
   */
  async enqueue<T>(
    sessionID: string,
    action: (_session: WorkflowSession | null, _rootSessionId: string) => Promise<T> | T
  ): Promise<T> {
    const rootSessionId = this.resolveRoot(sessionID);

    // Reentrant path: this call is nested inside an action for the same root.
    // It runs on the session that action already loaded — reloading here would
    // give it a second copy, and the outer save would silently drop its write.
    const active = this.active.getStore();
    if (active && active.root === rootSessionId) {
      return action(active.session, rootSessionId);
    }

    const prev = this.queues.get(rootSessionId) ?? Promise.resolve();
    const current: Promise<T> = prev.then(async () => {
      const loaded = await this.store.load(rootSessionId);
      const result = await this.active.run({ root: rootSessionId, session: loaded }, async () =>
        action(loaded, rootSessionId)
      );
      if (loaded !== null) {
        await this.store.save(loaded);
      }
      void this.log('debug', `SessionQueue enqueued for root ${rootSessionId}`, {
        sessionID,
        hasSession: loaded !== null,
      });
      return result;
    });

    this.queues.set(
      rootSessionId,
      current.catch((err) => {
        this.log('error', `SessionQueue action failed for root ${rootSessionId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }) as Promise<void>
    );

    return current;
  }

  /**
   * Walk the parent chain using the store's parent cache.
   * Every node in the chain returns the root, so re-entering with any
   * intermediate ID produces the same result without I/O.
   */
  private resolveRoot(sessionID: string): string {
    let current = sessionID;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const parentID = this.store.parentCache.get(current);
      if (!parentID || parentID === current) return current;
      current = parentID;
    }
    return current;
  }

  clear(): void {
    this.queues.clear();
  }
}
