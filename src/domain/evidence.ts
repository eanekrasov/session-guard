import type { WorkflowResult } from './engine.ts';

export const MUTATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const WORKFLOW_RESULT_RE = /<workflow-result>([\s\S]*?)<\/workflow-result>/gu;

function isValidWorkflowResult(value: unknown): value is WorkflowResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.stage !== 'string') return false;
  if (obj.status !== 'pass' && obj.status !== 'fail') return false;
  if (typeof obj.summary !== 'string' || obj.summary.length === 0) return false;
  if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) return false;
  if (!obj.evidence.every((e: unknown) => typeof e === 'string' && e.length > 0)) return false;
  return true;
}

/**
 * Parse a `<workflow-result>` XML tag from tool output.
 * Iterates from last to first — last valid tag wins.
 * Returns null when no valid tag is found.
 */
export function parseWorkflowResult(output: string): WorkflowResult | null {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(WORKFLOW_RESULT_RE.source, WORKFLOW_RESULT_RE.flags);
  while ((match = regex.exec(output)) !== null) {
    matches.push(match[1]);
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]);
      if (isValidWorkflowResult(parsed)) {
        return parsed;
      }
    } catch {
      // Malformed JSON — skip to next
    }
  }

  return null;
}
