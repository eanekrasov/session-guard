import { AsyncLocalStorage } from 'node:async_hooks';

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
 * session record and is never written into a workflow session file.
 *
 * SessionQueue handles ONLY serialization — no load, no save. The caller
 * provides the loaded session context or uses `SessionExecutor.run()` for
 * the full lifecycle.
 *
 * Supports reentrant calls: if an enqueued action calls enqueue() again for
 * the same root session ID, the nested call executes inline (no queue wait).
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
  private readonly active = new AsyncLocalStorage<{ root: string }>();

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

  constructor(log?: LogFn, resolveParent?: ResolveParentFn) {
    this.log = log ?? (() => Promise.resolve());
    this.resolveParent = resolveParent;
  }

  /**
   * Enqueue an action for a session. Resolves the root session ID through the
   * parent chain, but does NOT load or save the session — the caller is
   * responsible for persistence.
   *
   * If the caller is already inside a queue execution for the same root session
   * (reentrant call), the action runs inline. Otherwise it chains on the root's
   * promise chain.
   *
   * Error from one action is swallowed in the stored chain so subsequent
   * actions for the same root still run, but the original caller still
   * receives the rejection.
   */
  async enqueue<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
    const rootSessionId = await this.resolveRoot(sessionID);

    // Reentrant path: this call is nested inside an action for the same root.
    const active = this.active.getStore();
    if (active && active.root === rootSessionId) {
      return action();
    }

    const prev = this.queues.get(rootSessionId) ?? Promise.resolve();
    const current: Promise<T> = prev.then(async () =>
      this.active.run({ root: rootSessionId }, () => action())
    );

    // The stored tail drops itself once it is the last one for this root, so
    // the map holds only roots with work in flight.
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

      let parentID = this.parentCache.get(current);
      if (parentID === undefined && this.resolveParent) {
        try {
          parentID = (await this.resolveParent(current)) ?? current;
        } catch (err) {
          void this.log('debug', `SessionQueue: parent lookup failed for ${current}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // A transient host failure is not evidence that this session is a
          // root. Do not memoise the fallback: the next request must retry the
          // lookup so parent workflow restrictions can recover.
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

  clear(): void {
    this.queues.clear();
  }
}
