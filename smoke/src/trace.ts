import type { NormalizedToolCall, SmokeWorkflowState } from './host/types.ts';

export function formatToolTrace(toolCalls: NormalizedToolCall[]): string {
  if (toolCalls.length === 0) return 'tools=[]';
  return `tools=[${toolCalls.map((call) => `${call.name}:${call.status}`).join(', ')}]`;
}

export function summarizeWorkflowCheckpoint(
  state: SmokeWorkflowState | null,
  revision?: number
): string {
  const revisionLabel = revision === undefined ? 'unknown' : String(revision);
  const stage = state?.currentStage ?? '(none)';
  const gates = Object.entries(state?.stageGates ?? {})
    .map(([id, status]) => `${id}:${status}`)
    .join(', ');
  return `revision=${revisionLabel} stage=${stage} gates=[${gates}]`;
}
