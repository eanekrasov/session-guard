import type { WorkflowSession } from '../session/session-schema.ts';

/**
 * Extract the shell command from bash tool arguments.
 *
 * The host passes bash arguments as `{ command: "..." }`, so stringifying the
 * whole object hides the command behind JSON punctuation and defeats the
 * anchored patterns in `hasForbiddenGitSubcommand`. Unrecognised shapes fall
 * back to the serialised form so they are still scanned.
 */
export function extractBashCommand(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    const command = (args as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return JSON.stringify(args ?? '');
}

/**
 * Check if a command contains a forbidden git subcommand (commit or push).
 * Kept as a generic guard, not a commit-specific lifecycle.
 */
export function hasForbiddenGitSubcommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (/^git\s+(commit|push)\b/.test(normalized)) return true;
  return /[&|;]\s*git\s+(commit|push)\b/.test(normalized);
}

/**
 * @deprecated Commit has no privileged lifecycle. Use generic step completion.
 */
export function canCommit(_session: WorkflowSession, _requiredGates: string[]): boolean {
  return false;
}

/**
 * @deprecated No special commit command detection. Steps use generic lifecycle.
 */
export function isCommitTaskCommand(_command: string): boolean {
  return false;
}
