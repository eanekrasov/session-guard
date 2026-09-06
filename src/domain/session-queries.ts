import { getGate } from '../session/helpers.ts';
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
 * Check if the session can commit: all required gates must pass, all tasks completed.
 */
export function canCommit(session: WorkflowSession, requiredGates: string[]): boolean {
  for (const gateId of requiredGates) {
    const gate = getGate(session, gateId);
    if (!gate) return false;
    if (gate.status !== 'passed') return false;
  }

  const tasks = Object.values(session.tasks ?? {}).flat();
  return tasks.every((t) => t.status === 'completed');
}

// ─── P1-012: Commit Permit helpers ────────────────────────────────────────────

/**
 * Check if a command contains a forbidden git subcommand (commit or push).
 */
export function hasForbiddenGitSubcommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  // Match git commit or git push at the start of the command
  if (/^git\s+(commit|push)\b/.test(normalized)) return true;
  // Match git commit or git push after &&, ||, or ;
  return /[&|;]\s*git\s+(commit|push)\b/.test(normalized);
}

/**
 * Check if a command is a commit task (commit-task.ts).
 */
export function isCommitTaskCommand(command: string): boolean {
  return /commit-task\.ts\b/.test(command.trim());
}
