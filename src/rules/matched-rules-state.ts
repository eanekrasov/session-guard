import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createDebugLog, logWarningAlways } from './debug.js';

const debugLog = createDebugLog();

export interface MatchedRulesState {
  sessionID: string;
  matchedRulePaths: string[];
  evaluatedAt: number;
}

interface MatchedRulesStateStoreOptions {
  stateDir?: string;
}

// Strict pattern for safe sessionID: alphanumeric, underscore, hyphen only
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidSessionID(sessionID: string): boolean {
  return SAFE_SESSION_ID_PATTERN.test(sessionID);
}

function resolveStateDir(): string {
  return path.join(os.homedir(), '.opencode', 'state', 'opencode-rules');
}

function buildStateFilePath(sessionID: string, stateDir: string): string {
  if (!isValidSessionID(sessionID)) {
    throw new Error(`Invalid sessionID: ${sessionID}`);
  }
  return path.join(stateDir, `${sessionID}.json`);
}

/**
 * Which rules matched in a session, remembered for the sidebar.
 *
 * **Writing is best-effort and says so here rather than in its return type.**
 * A filesystem failure is warned about and then dropped: the caller gets a
 * resolved promise and cannot tell the write did not happen. That is deliberate
 * — both writers are hook handlers with nothing to retry and nobody to tell,
 * and the reader already treats missing state as normal, because a session that
 * has not been evaluated yet has none.
 *
 * The same goes for concurrency. `writeQueues` serialises writes within one
 * instance, and that is all it does: two instances sharing a state directory
 * both read the old state, both add their own paths and both rename their own
 * file over it, so one merge is lost every time. The atomic rename protects
 * the file from being torn, never the read-modify-write around it. Production
 * builds one store per runtime, so nothing reaches this today — `WorkflowStore`
 * is where a cross-process lock lives, because losing one of its writes loses
 * workflow state.
 *
 * What follows from all of it: this is a hint, not a source of truth. Nothing
 * that decides anything may depend on it. If something ever needs to know
 * whether the state survived, this class has to start reporting failure and
 * holding a lock across processes, and both callers have to grow somewhere to
 * report to.
 */
export class MatchedRulesStateStore {
  private readonly stateDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(opts: MatchedRulesStateStoreOptions = {}) {
    this.stateDir = opts.stateDir ?? resolveStateDir();
  }

  /**
   * Replace semantics for full durable turns.
   *
   * Best-effort: a filesystem failure resolves like a success (see the class
   * doc). Only an invalid sessionID rejects.
   *
   * @throws {Error} If sessionID fails validation.
   */
  write(sessionID: string, matchedPaths: readonly string[]): Promise<void> {
    this.assertValidSessionID(sessionID);
    return this.enqueue(sessionID, async () => ({
      sessionID,
      matchedRulePaths: [...matchedPaths],
      evaluatedAt: Date.now(),
    }));
  }

  /**
   * Union semantics for mid-session admissions: atomically merges the new
   * paths with the persisted state so existing matched rules survive.
   *
   * Best-effort: a filesystem failure resolves like a success (see the class
   * doc). Only an invalid sessionID rejects.
   *
   * @throws {Error} If sessionID fails validation.
   */
  merge(sessionID: string, matchedPaths: readonly string[]): Promise<void> {
    this.assertValidSessionID(sessionID);
    return this.enqueue(sessionID, async () => {
      const existing = await readMatchedRulesState(sessionID, {
        stateDir: this.stateDir,
      });
      return {
        sessionID,
        matchedRulePaths: [...new Set([...(existing?.matchedRulePaths ?? []), ...matchedPaths])],
        evaluatedAt: Date.now(),
      };
    });
  }

  private assertValidSessionID(sessionID: string): void {
    if (!isValidSessionID(sessionID)) {
      throw new Error(`Invalid sessionID: ${sessionID}`);
    }
  }

  /** Serialize per-session writes; each operation computes its state inside
   * the queue so concurrent merges cannot interleave read-modify-write. */
  private enqueue(sessionID: string, operation: () => Promise<MatchedRulesState>): Promise<void> {
    const previous = this.writeQueues.get(sessionID) ?? Promise.resolve();
    const current = previous
      .then(async () => this.doAtomicWrite(sessionID, await operation()))
      .finally(() => {
        if (this.writeQueues.get(sessionID) === current) {
          this.writeQueues.delete(sessionID);
        }
      });
    this.writeQueues.set(sessionID, current);
    return current;
  }

  private async doAtomicWrite(sessionID: string, state: MatchedRulesState): Promise<void> {
    const finalPath = buildStateFilePath(sessionID, this.stateDir);
    const tempPath = path.join(
      this.stateDir,
      `.${sessionID}-${crypto.randomBytes(8).toString('hex')}.tmp`
    );

    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      const content = JSON.stringify(state);
      await fs.writeFile(tempPath, content, 'utf-8');
      await fs.rename(tempPath, finalPath);
    } catch (error) {
      // Warned unconditionally: this write is not observable by its caller,
      // so a debug-gated message would make a lost write leave no trace at all
      // unless somebody had already suspected one.
      logWarningAlways(`Failed to write matched rules state for session ${sessionID}`, error);

      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/** Read matched rules state. @throws {Error} If sessionID fails validation. */
export async function readMatchedRulesState(
  sessionID: string,
  options: { stateDir?: string } = {}
): Promise<MatchedRulesState | null> {
  const filePath = buildStateFilePath(sessionID, options.stateDir ?? resolveStateDir());

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);

    if (!isValidMatchedRulesState(parsed)) {
      debugLog(`Invalid matched rules state format for session ${sessionID}`);
      return null;
    }

    return parsed;
  } catch (error) {
    debugLog(`Failed to read matched rules state for session ${sessionID}: ${error}`);
    return null;
  }
}

function isValidMatchedRulesState(value: unknown): value is MatchedRulesState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj['sessionID'] !== 'string') {
    return false;
  }

  if (typeof obj['evaluatedAt'] !== 'number') {
    return false;
  }

  if (!Array.isArray(obj['matchedRulePaths'])) {
    return false;
  }

  for (const item of obj['matchedRulePaths']) {
    if (typeof item !== 'string') {
      return false;
    }
  }

  return true;
}
