/**
 * RunView — read-only projection of a WorkflowSnapshot for dashboard/TUI/explain.
 *
 * Never mutates the snapshot. Inspection is side-effect free.
 */

import type { WorkflowSnapshot, ExecutionRef } from './workflow-model.ts';

export interface ScopeView {
  id: string;
  flowId: string;
  status: string;
  cursorExecutionId: string;
  parentExecutionId: string | null;
}

export interface ExecutionView {
  id: string;
  scopeId: string;
  nodeId: string;
  occurrence: number;
  status: string;
  currentAttemptId: string;
}

export interface AttemptView {
  id: string;
  attemptNumber: number;
  status: string;
  resultId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DecisionView {
  id: string;
  purpose: string;
  status: string;
  outcome: string | null;
  subjects: Array<{ id?: string; version?: string }>;
}

export interface TransitionView {
  id: string;
  scopeId: string;
  transitionId: string;
  fromExecutionId: string;
  toExecutionId: string;
  outcome: string;
}

export interface PendingItem {
  kind: 'decision' | 'execution' | 'transition';
  id: string;
  reason: string;
  details: Record<string, unknown>;
}

export interface RunView {
  runId: string;
  revision: number;
  title: string;
  status: string;
  definitionDigest: string;
  createdAt: string;
  updatedAt: string;
  scopes: ScopeView[];
  executions: ExecutionView[];
  attempts: AttemptView[];
  decisions: DecisionView[];
  transitions: TransitionView[];
  pending: PendingItem[];
}

/**
 * Project a WorkflowSnapshot into a read-only RunView.
 */
export function projectRunView(snapshot: WorkflowSnapshot): RunView {
  const scopes: ScopeView[] = Object.values(snapshot.scopes).map((s) => ({
    id: s.id,
    flowId: s.flowId,
    status: s.status,
    cursorExecutionId: s.cursorExecutionId,
    parentExecutionId: s.parentExecutionId,
  }));

  const executions: ExecutionView[] = Object.values(snapshot.executions).map((e) => ({
    id: e.id,
    scopeId: e.scopeId,
    nodeId: e.nodeId,
    occurrence: e.occurrence,
    status: e.status,
    currentAttemptId: e.currentAttemptId,
  }));

  const attempts: AttemptView[] = Object.values(snapshot.attempts).map((a) => ({
    id: a.id,
    attemptNumber: a.attemptNumber,
    status: a.status,
    resultId: a.resultId,
    createdAt: a.createdAt,
    finishedAt: a.finishedAt,
  }));

  const decisions: DecisionView[] = Object.values(snapshot.decisions).map((d) => ({
    id: d.id,
    purpose: d.purpose,
    status: d.status,
    outcome: d.resolution?.outcome ?? null,
    subjects: d.subjects,
  }));

  const transitions: TransitionView[] = Object.values(snapshot.transitions).map((t) => ({
    id: t.id,
    scopeId: t.scopeId,
    transitionId: t.transitionId,
    fromExecutionId: t.fromExecutionId,
    toExecutionId: t.toExecutionId,
    outcome: snapshot.results[t.consumedResultId]?.outcome ?? 'unknown',
  }));

  // Collect pending items
  const pending: PendingItem[] = [];

  for (const d of Object.values(snapshot.decisions)) {
    if (d.status === 'pending') {
      pending.push({
        kind: 'decision',
        id: d.id,
        reason: `Pending ${d.purpose} decision`,
        details: {
          subjects: d.subjects as Array<{ id: string; version: string }>,
          policyAuthority: d.policy.authority,
        },
      });
    }
  }

  for (const exec of Object.values(snapshot.executions)) {
    if (exec.status === 'ready' || exec.status === 'waiting') {
      pending.push({
        kind: 'execution',
        id: exec.id,
        reason: `Execution ${exec.id} is ${exec.status}`,
        details: { nodeId: exec.nodeId, scopeId: exec.scopeId },
      });
    }
  }

  return {
    runId: snapshot.run.id,
    revision: snapshot.run.revision,
    title: snapshot.run.title,
    status: snapshot.run.status,
    definitionDigest: snapshot.run.definitionDigest,
    createdAt: snapshot.run.createdAt,
    updatedAt: snapshot.run.updatedAt,
    scopes,
    executions,
    attempts,
    decisions,
    transitions,
    pending,
  };
}
