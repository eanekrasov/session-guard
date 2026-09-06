import { mkdir, readFile, rename, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowSessionSchema, CORE_GATES } from './session-schema.ts';
import type { WorkflowSession } from './session-schema.ts';
import type { LogFn } from '../app/logger.ts';

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSession(sessionId: string, profileId: string): WorkflowSession {
  return {
    schemaVersion: 2,
    sessionId,
    profileId,
    revision: 0,
    title: '',
    gates: CORE_GATES.map((g) => ({ ...g })),
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    activeTaskContexts: [],
    loopRuns: {},
    testStatus: {},
    deliveryPermit: null,
    deliveryReceipt: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    baselineHashes: [],
    changedFiles: [],
    currentPhase: 'planning',
    invariantViolations: [],
    consentedCallIDs: [],
  };
}

// ─── WorkflowStore ────────────────────────────────────────────────────────────

export class WorkflowStore {
  private directory: string;
  private locks = new Map<string, Promise<void>>();
  private log: LogFn;

  /** Cache: sessionID → parentID (or sessionID itself for root). Updated on save. */
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

    // Update parent cache on save
    const parentID = session.testStatus?.['parentID'];
    this.parentCache.set(session.sessionId, parentID ?? session.sessionId);
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
      .then(() => writeFile(tmpPath, json, { mode: 0o600 }))
      .then(() => rename(tmpPath, targetPath))
      .catch((err) => {
        void this.log('error', `Session save I/O failed for ${session.sessionId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
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

  async delete(sessionId: string): Promise<void> {
    this.parentCache.delete(sessionId);
    const filePath = this.sessionPath(sessionId);
    if (existsSync(filePath)) {
      await unlink(filePath);
      void this.log('info', `Session deleted: ${sessionId}`);
    }
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
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const decoded = decodeURIComponent(entry.name.slice(0, -5));
        ids.push(decoded);
      }
    }
    void this.log('info', `Listed sessions: ${ids.length} found`);
    return ids.sort();
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.directory, `${encodeURIComponent(sessionId)}.json`);
  }
}
