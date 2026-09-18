import type { WorkflowSession } from '../session/session-schema.ts';
import type { WorkflowStore } from '../session/session-store.ts';
import type { ResolveParentFn, SessionExecutor } from './session-executor.ts';

export interface RuntimeSessionContext {
  load(sessionID: string | undefined): Promise<WorkflowSession | null>;
  has(sessionID: string | undefined): Promise<boolean>;
  rootOf(sessionID: string): Promise<string>;
  parentOf(sessionID: string): Promise<string | null>;
  normalizeTool(tool: string): string;
}

/**
 * Resolves host session identity into the workflow session used by policy.
 * Loaded sessions are cloned because this interface is for inspection; writes
 * remain owned by SessionExecutor transactions or the existing orchestrators.
 */
export class RuntimeSessionContextImpl implements RuntimeSessionContext {
  constructor(
    private readonly store: WorkflowStore,
    private readonly executor: SessionExecutor,
    private readonly resolveParent?: ResolveParentFn
  ) {}

  async load(sessionID: string | undefined): Promise<WorkflowSession | null> {
    if (!sessionID) return null;
    const session = await this.store.load(await this.rootOf(sessionID));
    return session === null ? null : structuredClone(session);
  }

  async has(sessionID: string | undefined): Promise<boolean> {
    return (await this.load(sessionID)) !== null;
  }

  async rootOf(sessionID: string): Promise<string> {
    return this.executor.rootOf(sessionID);
  }

  async parentOf(sessionID: string): Promise<string | null> {
    if (!this.resolveParent) return null;
    try {
      return (await this.resolveParent(sessionID)) ?? null;
    } catch {
      return null;
    }
  }

  normalizeTool(tool: string): string {
    return tool.toLowerCase();
  }
}
