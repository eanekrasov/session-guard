import { mkdir, readFile, rename, writeFile, readdir, unlink, open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowSessionSchema } from './session-schema.ts';
import { sessionFileName, sessionIdFromFileName } from './session-files.ts';
import type { WorkflowSession } from './session-schema.ts';
import type { LogFn } from '../app/logger.ts';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * A new session, parked in the stage its own workflow starts in.
 *
 * `initialStage` used to be the literal `'planning'`, which is the base
 * profile's first stage written into the core. A schema declaring
 * `start → done` produced a session in a stage it does not have: no outgoing
 * edge, no admission, and nothing said so. Production passes the compiled
 * initial stage (`StateMachineEngine.getInitialStage`); the default is a
 * convenience for fixtures whose first stage is `planning`, and a caller that
 * relies on it for anything else gets the same defect back.
 */
export function createSession(
  sessionId: string,
  profileId: string,
  schemaId: string,
  initialStage: string = 'planning'
): WorkflowSession {
  return {
    schemaVersion: 2,
    sessionId,
    profileId,
    schemaId,
    revision: 0,
    title: '',
    // Gates are created on demand by the first verdict about them. A gate
    // nobody has spoken about is absent, and every reader already treats
    // absent as pending — so a seeded list would only be a copy of the
    // profile's declaration that can drift from it.
    gates: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryPermit: null,
    deliveryReceipt: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    changedFiles: [],
    currentStage: initialStage,
    invariantViolations: [],
    consentedCallIDs: [],
  };
}

/** How long a write waits for another process's lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 30_000;

/** A save built on a revision the file no longer holds. */
export class WorkflowSessionConflictError extends Error {
  readonly name = 'WorkflowSessionConflictError';
}

// ─── WorkflowStore ────────────────────────────────────────────────────────────

export class WorkflowStore {
  private directory: string;
  private locks = new Map<string, Promise<void>>();
  private log: LogFn;

  /**
   * Cache: sessionID → parentID (or sessionID itself for root).
   *
   * Filled only by `SessionQueue.resolveRoot` from what the host answered.
   * `save()` used to seed it from `session.testStatus['parentID']` before the
   * session had even been validated — a field no code ever wrote, and since
   * removed, so the entry it produced was always `sessionId → sessionId`.
   * That is the one answer that
   * must never be guessed: it marks the session as its own root and stops the
   * host from ever being asked, which is how a child would slip out of its
   * parent's workflow. The parent chain belongs to the host; only its reply
   * lands here.
   */
  readonly parentCache = new Map<string, string>();
  readonly onSave = new Set<() => void>();

  constructor(basePath: string, log?: LogFn) {
    this.directory = basePath;
    this.log = log ?? (() => Promise.resolve());
  }

  async save(session: WorkflowSession): Promise<void> {
    // Snapshot pre-mutation values so we can roll back if validation fails
    const revisionBefore = session.revision;
    const updatedAtBefore = session.updatedAt;

    session.revision++;
    session.updatedAt = new Date().toISOString();

    let clean: WorkflowSession;
    try {
      clean = WorkflowSessionSchema.parse(session);
    } catch (err) {
      // Roll back the mutations we just made so callers can retry
      session.revision = revisionBefore;
      session.updatedAt = updatedAtBefore;
      const message = `[ERROR] Failed to validate session: ${err instanceof Error ? err.message : String(err)}`;
      void this.log('error', message, { sessionId: session.sessionId });
      throw new Error(message);
    }

    const json = JSON.stringify(clean, null, 2) + '\n';
    const targetPath = this.sessionPath(session.sessionId);
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    void this.log('debug', 'Session saving', {
      sessionId: session.sessionId,
      dir: this.directory,
    });

    const key = session.sessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const chain = prev
      .then(() => mkdir(this.directory, { recursive: true }))
      // The revision check and the write are one step or they are nothing.
      // The in-process chain above serialises this instance; it says nothing
      // about a second WorkflowStore, a second plugin instance, or a second
      // host. Two of them each read the same revision, each passed the check
      // and each wrote — both reported success and one update vanished.
      .then(() =>
        this.withFileLock(session.sessionId, async () => {
          await this.assertNotStale(session.sessionId, revisionBefore);
          await writeFile(tmpPath, json, { mode: 0o600 });
          await rename(tmpPath, targetPath);
        })
      )
      .catch((err) => {
        // Undo the in-memory bump so the caller can reload and retry on a
        // clean object, exactly as the validation failure above does.
        session.revision = revisionBefore;
        session.updatedAt = updatedAtBefore;
        if (!(err instanceof WorkflowSessionConflictError)) {
          void this.log('error', `Session save I/O failed for ${session.sessionId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      })
      .finally(() => {
        // Always release the lock — even if I/O failed. Without .finally(),
        // a failed writeFile/rename would leak a stale rejected promise in
        // `this.locks`, causing every subsequent `save()` for this key to
        // hang or fail permanently.
        if (this.locks.get(key) === chain) {
          this.locks.delete(key);
        }
      });

    this.locks.set(key, chain);
    await chain;

    for (const cb of this.onSave) cb();
    void this.log('info', `Session saved: ${session.sessionId}`, {
      revision: clean.revision,
      tasksTotal: Object.values(clean.tasks).flat().length,
      tasksCompleted: Object.values(clean.tasks)
        .flat()
        .filter((task) => task.status === 'completed').length,
    });
  }

  /**
   * Hold the session's cross-process lock for the length of one write.
   *
   * `open(path, 'wx')` fails when the file exists, which is the only
   * compare-and-swap the filesystem offers. A lock older than
   * `LOCK_STALE_MS` belonged to a process that died holding it and is broken
   * rather than waited on — a write that cannot finish must not stop every
   * later one for ever.
   */
  private async withFileLock<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    const lockPath = `${this.sessionPath(sessionId)}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        await (await open(lockPath, 'wx')).close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

        const age = await stat(lockPath).then(
          (info) => Date.now() - info.mtimeMs,
          () => null // it went away underneath us; try to take it
        );
        if (age !== null && age > LOCK_STALE_MS) {
          void this.log('warn', `Breaking a stale session lock`, { sessionId, ageMs: age });
          await unlink(lockPath).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `[ERROR] Timed out waiting for the session lock on ${sessionId} after ${LOCK_TIMEOUT_MS}ms`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 8));
      }
    }

    try {
      return await write();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }

  /**
   * Refuse a write built on a revision somebody else has already replaced.
   *
   * `revision` was incremented on every save and compared against nothing, so
   * the field recorded how many times this process had written and said
   * nothing about whether the write was still valid. Two writers — a second
   * plugin instance, a second host — each loaded revision N and each wrote
   * N+1, and the later one silently erased the earlier one's work.
   *
   * Runs inside the per-session lock chain, so it is atomic against this
   * process's own writes as well.
   */
  private async assertNotStale(sessionId: string, revisionBefore: number): Promise<void> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return;

    let onDisk: number | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
      const value = (parsed as { revision?: unknown }).revision;
      if (typeof value === 'number') onDisk = value;
    } catch {
      // An unreadable or corrupt file carries no revision to conflict with.
      // Overwriting it is the repair, not the race.
      return;
    }

    if (onDisk === undefined || onDisk === revisionBefore) return;

    const message =
      `[ERROR] Session ${sessionId} changed underneath this write: ` +
      `loaded revision ${revisionBefore}, on disk ${onDisk}. Reload and retry.`;
    void this.log('error', message, { sessionId });
    throw new WorkflowSessionConflictError(message);
  }

  async load(sessionId: string): Promise<WorkflowSession | null> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return null;

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `[ERROR] Failed to read session file: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('[ERROR] Corrupt session file: invalid JSON');
    }

    const result = WorkflowSessionSchema.passthrough().safeParse(parsed);
    if (!result.success) {
      void this.log('warn', `Session schema mismatch (not our format): ${sessionId}`, {
        issues: result.error.issues.map((i) => i.message),
      });
      return null;
    }
    const data = result.data as WorkflowSession;
    void this.log('info', `Session loaded: ${sessionId}`, {
      revision: data.revision,
      profileId: data.profileId,
      directory: this.directory,
      filePath,
      storeDir: process.env.STATE_MACHINE_STORE_DIR ?? '(not set)',
    });
    return data;
  }

  /**
   * Remove a session, ordered against every write to it.
   *
   * A bare `unlink` took neither the in-process chain nor the file lock, so a
   * `save()` already holding its payload finished afterwards and renamed the
   * session back into place — the delete reported success and the file was
   * there. Sharing both locks makes the two operations ordered rather than
   * racing: whichever is queued last is the one that decides.
   *
   * A previous write that failed does not stop a delete, so this chains on
   * `prev.catch()` where `save()` chains on `prev` — a session nobody could
   * write must still be removable.
   */
  async delete(sessionId: string): Promise<void> {
    this.parentCache.delete(sessionId);
    const filePath = this.sessionPath(sessionId);

    const key = sessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let removed = false;
    const chain: Promise<void> = prev
      .catch(() => {})
      .then(() =>
        this.withFileLock(sessionId, async () => {
          if (!existsSync(filePath)) return;
          await unlink(filePath);
          removed = true;
        })
      )
      .finally(() => {
        if (this.locks.get(key) === chain) this.locks.delete(key);
      });

    this.locks.set(key, chain);
    await chain;
    if (removed) void this.log('info', `Session deleted: ${sessionId}`);
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        void this.log('info', 'Listed sessions: 0 found (directory does not exist)');
        return [];
      }
      void this.log('error', 'list: readdir failed', {
        error: nodeErr.message ?? String(err),
      });
      throw err;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // A name that will not decode was not written by this store. It used to
      // throw `URIError` out of the loop, and one stray file made every
      // session invisible.
      const decoded = sessionIdFromFileName(entry.name);
      if (decoded === null) continue;
      ids.push(decoded);
    }
    void this.log('info', `Listed sessions: ${ids.length} found`);
    return ids.sort();
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.directory, sessionFileName(sessionId));
  }
}
