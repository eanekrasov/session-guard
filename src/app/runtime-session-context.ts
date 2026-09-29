import type { LogFn } from './logger.ts';
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
    private readonly resolveParent?: ResolveParentFn,
    private readonly log?: LogFn
  ) {}

  async load(sessionID: string | undefined): Promise<WorkflowSession | null> {
    if (!sessionID) return null;
    void this.log?.('debug', 'RuntimeSessionContext: load session', { sessionID });
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

  /**
   * Привести имя инструмента к тому, под которым его знает workflow.
   *
   * Хосты называют одну и ту же возможность по-разному: V1 присылает субагентский диспатч
   * как `task`, а V2 — как `subagent`; V1 присылает команду оболочки как `bash`, а V2 — как
   * `shell`; патч V1 называет `apply_patch`, а V2 — `patch`. Гарды, инварианты (в том числе
   * `changedFiles`) и разбор `<workflow-result>` написаны против одной возможности, поэтому оба
   * имени нормализуются в одно: иначе на V2 субагент выполняет работу и сообщает вердикт, а
   * плагин не записывает ни его файлов, ни гейтов, ни завершения задачи, команда оболочки
   * проходит мимо правил, привязанных к `bash`, а патч — мимо правил и инвариантов,
   * привязанных к `apply_patch`.
   */
  normalizeTool(tool: string): string {
    const normalized = tool.toLowerCase();
    void this.log?.('debug', 'RuntimeSessionContext: normalizeTool', { tool, normalized });
    return TOOL_ALIASES[normalized] ?? normalized;
  }
}

/** Имена одной и той же возможности у разных версий хоста. */
const TOOL_ALIASES: Record<string, string> = {
  subagent: 'task',
  shell: 'bash',
  patch: 'apply_patch',
};
