/**
 * Tool argument types for OpenCode tools used by session-guard.
 *
 * These mirror the host's tool schemas. Not exported by @opencode-ai/sdk,
 * so we define them here for internal type safety.
 */

export interface BashToolArgs {
  command: string;
  workdir?: string;
  timeout?: number;
}

export interface ReadToolArgs {
  filePath: string;
  offset?: number;
  limit?: number;
}

export interface WriteToolArgs {
  filePath: string;
  content: string;
}

export interface EditToolArgs {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface GlobToolArgs {
  pattern: string;
  path?: string;
}

export interface GrepToolArgs {
  pattern: string;
  path?: string;
  include?: string;
}

export interface ApplyPatchToolArgs {
  patchText: string;
}

export interface TaskToolArgs {
  subagent_type: string;
  description: string;
  agent?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Union of all mutation tool argument types.
 * Used where any mutating tool may be passed.
 */
export type MutationToolArgs = BashToolArgs | WriteToolArgs | EditToolArgs | ApplyPatchToolArgs;

/**
 * All known tool argument types by tool name.
 * Keys match the host's tool names.
 */
export interface ToolArgsMap {
  bash: BashToolArgs;
  read: ReadToolArgs;
  write: WriteToolArgs;
  edit: EditToolArgs;
  glob: GlobToolArgs;
  grep: GrepToolArgs;
  apply_patch: ApplyPatchToolArgs;
  task: TaskToolArgs;
}

/**
 * Extract the args type for a specific tool name.
 * Returns `unknown` for unknown tools.
 */
export type ToolArgs<T extends string> = T extends keyof ToolArgsMap ? ToolArgsMap[T] : unknown;

/**
 * Type guard to narrow unknown args to a specific tool's args.
 */
export function isToolArgs<T extends keyof ToolArgsMap>(
  toolName: T,
  args: unknown,
  keys: string[]
): args is ToolArgsMap[T] {
  if (!args || typeof args !== 'object') return false;
  const obj = args as Record<string, unknown>;
  return keys.every((k) => k in obj && typeof obj[k] === 'string');
}
