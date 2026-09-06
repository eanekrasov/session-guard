import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';
import type { LogFn } from './logger.ts';

/**
 * Ask the host for a session's parent. Returns the parent id, or null when the
 * session is a root, unknown, or the host could not be reached.
 */
export type ResolveParentFn = (_sessionID: string) => Promise<string | null>;

/**
 * SessionQueue — per-root-session serialized execution queue.
 *
 * All actions for the same root session (resolved by walking the parentID
 * chain) are serialized via a single promise chain.
 *
 * The chain is the host's, not ours. `parentID` is a field of the host's
 * session record and is never written into a workflow session file, so
 * `store.parentCache` on its own was always identity and this resolution was
 * a no-op in production: a dispatched subagent works in its own session, and
 * its writes never reached the parent's task scope or invariants. The cache is
 * kept as the memo — one lookup per session id, and every node of a walked
 * chain is memoised to its root.
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
  private resolveParent?: ResolveParentFn;

  constructor(store: WorkflowStore, log?: LogFn, resolveParent?: ResolveParentFn) {
    this.store = store;
    this.log = log ?? (() => Promise.resolve());
    this.resolveParent = resolveParent;
  }

  /**
   * Enqueue an action for a session. Resolves the root session ID through the
   * store's parent cache, asking the host for any hop the cache does not hold.
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
    const rootSessionId = await this.resolveRoot(sessionID);

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

    // The stored tail drops itself once it is the last one for this root, so
    // the map holds only roots with work in flight. It used to grow one entry
    // per session for the life of the process and was only ever emptied
    // wholesale by `clear()`.
    const tail: Promise<void> = current
      .catch((err) => {
        this.log('error', `SessionQueue action failed for root ${rootSessionId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .then(() => {
        if (this.queues.get(rootSessionId) === tail) this.queues.delete(rootSessionId);
      });
    this.queues.set(rootSessionId, tail);

    return current;
  }

  /**
   * The root of a session's parent chain — the session the plugin governs.
   *
   * A hook fires with the id of the session the tool ran in, which for a
   * dispatched subagent is a child. Anything that looks a workflow session up
   * from a hook's id must ask this first.
   */
  async rootOf(sessionID: string): Promise<string> {
    return this.resolveRoot(sessionID);
  }

  /**
   * Walk the parent chain, cache first and the host for anything it misses.
   *
   * Every node walked is memoised straight to the root, so re-entering with any
   * intermediate id produces the same answer without further I/O. A host that
   * cannot answer leaves the session as its own root — the behaviour before
   * this resolution existed, and the safe one: an unknown chain must not
   * silently attach a session to somebody else's queue.
   */
  private async resolveRoot(sessionID: string): Promise<string> {
    const walked: string[] = [];
    let current = sessionID;
    const visited = new Set<string>();

    while (current && !visited.has(current)) {
      visited.add(current);
      walked.push(current);

      let parentID = this.store.parentCache.get(current);
      if (parentID === undefined && this.resolveParent) {
        try {
          parentID = (await this.resolveParent(current)) ?? current;
        } catch (err) {
          void this.log('debug', `SessionQueue: parent lookup failed for ${current}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          parentID = current;
        }
        this.store.parentCache.set(current, parentID);
      }

      if (!parentID || parentID === current) break;
      current = parentID;
    }

    for (const node of walked) this.store.parentCache.set(node, current);
    return current;
  }

  clear(): void {
    this.queues.clear();
  }
}
