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
 * the same root session ID, the nested call executes inline on the already-
 * loaded session rather than creating a new promise chain link.
 */
export class SessionQueue {
  /** Per-root-session serialisation queue (key = resolved root session ID). */
  private queues = new Map<string, Promise<void>>();

  /**
   * Set of root session IDs that are currently executing inside the queue.
   * Used for reentrancy detection: if the root is already in this set,
   * the new enqueue runs inline.
   */
  private executing = new Set<string>();

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
  enqueue<T>(
    sessionID: string,
    action: (_session: WorkflowSession | null, _rootSessionId: string) => Promise<T> | T
  ): Promise<T> {
    const rootSessionId = this.resolveRoot(sessionID);

    // Reentrant path: if we're already inside a queue execution for this root,
    // run the action inline using the already-loaded session.
    if (this.executing.has(rootSessionId)) {
      return this.executeInline(rootSessionId, action);
    }

    const prev = this.queues.get(rootSessionId) ?? Promise.resolve();
    const current: Promise<T> = prev.then(async () => {
      this.executing.add(rootSessionId);
      try {
        const loaded = await this.store.load(rootSessionId);
        const result = await action(loaded, rootSessionId);
        if (loaded !== null) {
          await this.store.save(loaded);
        }
        void this.log('debug', `SessionQueue enqueued for root ${rootSessionId}`, {
          sessionID,
          hasSession: loaded !== null,
        });
        return result;
      } finally {
        this.executing.delete(rootSessionId);
      }
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
   * Execute an action inline for a reentrant call.
   * Loads the session fresh (the outer execution may have loaded a different
   * reference) and saves on completion.
   */
  private async executeInline<T>(
    rootSessionId: string,
    action: (_session: WorkflowSession | null, _rootSessionId: string) => Promise<T> | T
  ): Promise<T> {
    const loaded = await this.store.load(rootSessionId);
    const result = await action(loaded, rootSessionId);
    if (loaded !== null) {
      await this.store.save(loaded);
    }
    return result;
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
