import type { WorkflowSession } from '../session/session-schema.ts';

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
