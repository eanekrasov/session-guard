/**
 * GuardEvaluator — evaluates JS-like guard expressions in a sandboxed context.
 *
 * Expression context includes:
 * - `session` — the current workflow session context (e.g., SessionFacts)
 * - `approved(type)` — function, checks if an approval of the given type has been granted
 * - Custom guard functions — exports from the profile's guards.ts
 *
 * Uses the AST-based evaluator (guard-ast.ts) which cannot access globals,
 * prototypes, or perform arbitrary calls. Replaces the previous `new Function`
 * approach.
 */
import { evaluateGuard as astEvaluateGuard } from './guard-ast.ts';
import type { GuardEvaluationSession } from '../domain/session-facts.ts';
import type { TaskStatus } from '../session/session-schema.ts';

export interface GuardEvaluationContext {
  currentLoopListKey?: string;
}

export class GuardEvaluator {
  private readonly builtins: Record<string, (...args: unknown[]) => unknown>;
  private readonly session: Record<string, unknown>;
  private readonly guards: Record<string, (...args: unknown[]) => unknown>;

  /**
   * @param session — the current workflow session context (data-only subset)
   * @param guards — custom guard functions from guards.ts (optional)
   * @param evaluationContext — transient context for the guard evaluation
   */
  private readonly onError?: (_error: Error, _expression: string) => void;

  constructor(
    session: GuardEvaluationSession,
    guards?: Record<string, Function>,
    evaluationContext: GuardEvaluationContext = {},
    onError?: (_error: Error, _expression: string) => void
  ) {
    this.onError = onError;
    const sessionFacts = session;
    const approvedFn = (type: string): boolean =>
      (sessionFacts.approvals ?? []).some((a) => a.type === type && a.status === 'granted');
    const isExhaustedFn = (budgetKey: string): boolean => {
      const budget = sessionFacts.retryBudgets?.[budgetKey];
      return budget ? budget.attempts >= budget.maximum : false;
    };
    const hasPendingTasksFn = (): boolean => {
      const taskLists = sessionFacts.tasks;
      if (Array.isArray(taskLists)) {
        return taskLists.some((t) => t.status === 'pending' || t.status === 'running');
      }
      // Record<string, Task[]> shape
      if (taskLists && typeof taskLists === 'object') {
        return Object.values(taskLists).some(
          (list) =>
            Array.isArray(list) &&
            list.some((t) => t.status === 'pending' || t.status === 'running')
        );
      }
      return false;
    };
    const allTasksStatusFn = (status: TaskStatus, explicitListKey?: string): boolean => {
      const taskLists = sessionFacts.tasks;
      if (!taskLists || typeof taskLists !== 'object') return false;

      let listKey = explicitListKey;
      if (listKey === undefined) {
        listKey = evaluationContext.currentLoopListKey;
      }
      if (listKey === undefined) {
        const loopRuns = sessionFacts.loopRuns as Record<string, { listKey: string }> | undefined;
        const activeOperations = sessionFacts.activeOperations as
          Record<string, { runId: string }> | undefined;
        if (!loopRuns || !activeOperations) return false;
        const operations = Array.isArray(activeOperations)
          ? activeOperations
          : Object.values(activeOperations);
        const activeListKeys = new Set<string>();
        for (const operation of operations) {
          if (!operation || typeof operation !== 'object' || !('runId' in operation)) continue;
          const run = loopRuns[operation.runId];
          if (run && typeof run === 'object' && 'listKey' in run) {
            activeListKeys.add(run.listKey);
          }
        }
        if (activeListKeys.size !== 1) return false;
        listKey = activeListKeys.values().next().value;
      }

      if (typeof listKey !== 'string') return false;
      // Narrow taskLists from union type — cast Record part for indexing
      const taskArray = Array.isArray(taskLists)
        ? taskLists
        : (taskLists as Record<string, readonly { id: string; status: TaskStatus }[]>)[listKey];
      if (!Array.isArray(taskArray) || taskArray.length === 0) return false;
      return taskArray.every(
        (task) => task && typeof task === 'object' && 'status' in task && task.status === status
      );
    };

    const allTasksCompletedFn = (listKey?: string): boolean =>
      allTasksStatusFn('completed', listKey);
    const taskStatus = (listKey: unknown, status: TaskStatus): boolean => {
      const tasks = sessionFacts.tasks;
      if (!tasks) return false;
      if (listKey === undefined) {
        const lists = Array.isArray(tasks) ? [tasks] : Object.values(tasks);
        return lists.some(
          (list) => Array.isArray(list) && list.some((task) => task.status === status)
        );
      }
      if (typeof listKey !== 'string' || Array.isArray(tasks)) return false;
      const list = (tasks as Record<string, readonly { status?: string }[]>)[listKey];
      return Array.isArray(list) && list.some((task) => task.status === status);
    };

    // Build the session with approved and allTasksCompleted attached so
    // expressions like session.approved('plan') work
    this.session = Object.assign({}, session, {
      approved: approvedFn,
      allTasksCompleted: allTasksCompletedFn,
    });

    // Builtins — callable by name in guard expressions
    this.builtins = {
      approved: (...args: unknown[]) => approvedFn(String(args[0])),
      isExhausted: (...args: unknown[]) => isExhaustedFn(String(args[0])),
      hasPendingTasks: (listKey: unknown) =>
        listKey === undefined ? hasPendingTasksFn() : taskStatus(listKey, 'pending'),
      hasRunningTasks: (listKey: unknown) => taskStatus(listKey, 'running'),
      hasCompletedTasks: (listKey: unknown) => taskStatus(listKey, 'completed'),
      hasFailedTasks: (listKey: unknown) => taskStatus(listKey, 'failed'),
      hasCancelledTasks: (listKey: unknown) => taskStatus(listKey, 'cancelled'),
      allTasksPending: (listKey: unknown) =>
        allTasksStatusFn('pending', typeof listKey === 'string' ? listKey : undefined),
      allTasksRunning: (listKey: unknown) =>
        allTasksStatusFn('running', typeof listKey === 'string' ? listKey : undefined),
      allTasksFailed: (listKey: unknown) =>
        allTasksStatusFn('failed', typeof listKey === 'string' ? listKey : undefined),
      allTasksCancelled: (listKey: unknown) =>
        allTasksStatusFn('cancelled', typeof listKey === 'string' ? listKey : undefined),
      allTasksCompleted: (...args: unknown[]) =>
        allTasksCompletedFn(typeof args[0] === 'string' ? args[0] : undefined),
    };

    this.guards = (guards ?? {}) as Record<string, (...args: unknown[]) => unknown>;
  }

  /**
   * Evaluate a guard expression string against the context using the AST evaluator.
   * Returns false for any runtime error, parse error, or step-limit exceeded.
   */
  evaluate(expression: string): boolean {
    try {
      return astEvaluateGuard(expression, this.session, this.builtins, this.guards, this.onError);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)), expression);
      return false;
    }
  }
}
