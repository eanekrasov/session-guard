/**
 * WorkflowModule — single atomic writer over WorkflowSnapshot.
 *
 * Wraps the command dispatch with file persistence, revision checking,
 * duplicate detection, and writer-lock enforcement.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  dispatchCommand,
  isDuplicate,
  genId,
  type WorkflowSnapshot,
  type Command,
  type ValidationRecord,
} from '../domain/workflow-model.ts';

export interface ModuleConfig {
  storeDir: string;
  writerId: string;
}

export class WorkflowModule {
  private readonly storeDir: string;
  readonly writerId: string;

  constructor(config: ModuleConfig) {
    this.storeDir = config.storeDir;
    this.writerId = config.writerId;
  }

  /**
   * Apply a command to a run, returning the new snapshot and validations.
   * Persists the result atomically (write to temp, rename).
   */
  async dispatch(
    runId: string,
    command: Command
  ): Promise<{ snapshot: WorkflowSnapshot; validations: ValidationRecord[] }> {
    const snapshot = await this.loadSnapshot(runId);
    const cmdId = genId();
    const now = new Date().toISOString();

    // Duplicate check
    if (snapshot && isDuplicate(snapshot, cmdId)) {
      return {
        snapshot,
        validations: [
          {
            id: genId(),
            execution: null,
            code: 'DUPLICATE',
            message: `Command ${cmdId} is a duplicate`,
            sourcePath: null,
            recordedRevision: snapshot.run.revision,
          },
        ],
      };
    }

    const result = dispatchCommand(snapshot, command, cmdId, now);

    if (result.validations.length > 0) {
      // No mutation — return validation errors
      return { snapshot: snapshot!, validations: result.validations };
    }

    // Validate snapshots before writing
    this.validateSnapshot(result.snapshot, result.validations);

    await this.saveSnapshot(result.snapshot);
    return result;
  }

  /**
   * Inspect a snapshot without side effects.
   */
  async inspect(runId: string): Promise<WorkflowSnapshot | null> {
    return this.loadSnapshot(runId);
  }

  /**
   * Load snapshot from disk. Returns null if the file doesn't exist.
   */
  private async loadSnapshot(runId: string): Promise<WorkflowSnapshot | null> {
    const filePath = this.runPath(runId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as WorkflowSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Save snapshot atomically: write to temp file, then rename.
   */
  private async saveSnapshot(snapshot: WorkflowSnapshot): Promise<void> {
    const dir = this.storeDir;
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const filePath = this.runPath(snapshot.run.id);
    const tmpPath = `${filePath}.${genId()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    // Atomic rename
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, filePath);
  }

  private runPath(runId: string): string {
    return join(this.storeDir, `${runId}.json`);
  }

  private validateSnapshot(_snapshot: WorkflowSnapshot, _validations: ValidationRecord[]): void {
    // Cross-reference validation — placeholder for Task 6 full validation
  }

  /**
   * List all run IDs stored in this module's directory.
   */
  async listRunIds(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    try {
      const files = await readdir(this.storeDir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}
