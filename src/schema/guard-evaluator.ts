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

export interface GuardEvaluationContext {
  currentLoopListKey?: string;
}

export class GuardEvaluator {
  private readonly builtins: Record<string, (...args: unknown[]) => unknown>;
  private readonly session: Record<string, unknown>;
  private readonly guards: Record<string, (...args: unknown[]) => unknown>;

  /**
   * @param session — the current workflow session context (e.g., SessionFacts)
   * @param guards — custom guard functions from guards.ts (optional)
   * @param evaluationContext — transient context for the guard evaluation
   */
  private readonly onError?: (_error: Error, _expression: string) => void;

  constructor(
    session: Record<string, unknown>,
    guards?: Record<string, Function>,
    evaluationContext: GuardEvaluationContext = {},
    onError?: (_error: Error, _expression: string) => void
  ) {
    this.onError = onError;
    const sessionFacts = session as { approvals?: Array<{ type: string; status: string }> };
    const approvedFn = (type: string): boolean =>
      (sessionFacts.approvals ?? []).some((a) => a.type === type && a.status === 'granted');
    const isExhaustedFn = (budgetKey: string): boolean => {
      const budget = (session as Record<string, unknown>).retryBudgets as
        Record<string, { attempts: number; maximum: number }> | undefined;
      return budget?.[budgetKey]
        ? budget[budgetKey]!.attempts >= budget[budgetKey]!.maximum
        : false;
    };
    const hasPendingTasksFn = (): boolean => {
      const taskLists = (session as Record<string, unknown>).tasks as
        Record<string, Array<{ status: string }>> | undefined;
      const impl = taskLists?.implementation ?? [];
      if (impl.length > 0) {
        return impl.some((t) => t.status === 'pending' || t.status === 'running');
      }
      if (taskLists && typeof taskLists === 'object') {
        return Object.values(taskLists).some(
          (list) =>
            Array.isArray(list) &&
            list.some((t) => t.status === 'pending' || t.status === 'running')
        );
      }
      return false;
    };
    const allTasksCompletedFn = (explicitListKey?: string): boolean => {
      const taskLists = (session as Record<string, unknown>).tasks as
        Record<string, Array<{ status: string }>> | undefined;
      if (!taskLists || typeof taskLists !== 'object') return false;

      let listKey = explicitListKey;
      if (listKey === undefined) {
        listKey = evaluationContext.currentLoopListKey;
      }
      if (listKey === undefined) {
        const loopRuns = (session as Record<string, unknown>).loopRuns as
          Record<string, { listKey: string }> | undefined;
        const activeOperations = (session as Record<string, unknown>).activeOperations as
          Record<string, { runId: string }> | undefined;
        if (typeof loopRuns !== 'object' || !activeOperations) return false;
        const operations = Array.isArray(activeOperations)
          ? activeOperations
          : typeof activeOperations === 'object'
            ? Object.values(activeOperations)
            : [];
        const activeListKeys = new Set<string>();
        for (const operation of operations) {
          if (
            typeof operation !== 'object' ||
            operation === null ||
            !('runId' in operation) ||
            typeof (operation as { runId: string }).runId !== 'string'
          ) {
            continue;
          }
          const run = loopRuns[(operation as { runId: string }).runId];
          if (
            typeof run === 'object' &&
            run !== null &&
            'listKey' in run &&
            typeof (run as { listKey: string }).listKey === 'string'
          ) {
            activeListKeys.add((run as { listKey: string }).listKey);
          }
        }
        if (activeListKeys.size !== 1) return false;
        listKey = activeListKeys.values().next().value;
      }

      if (typeof listKey !== 'string') return false;
      const tasks = taskLists[listKey];
      if (!Array.isArray(tasks) || tasks.length === 0) return false;
      return tasks.every(
        (task) =>
          typeof task === 'object' &&
          task !== null &&
          'status' in task &&
          task.status === 'completed'
      );
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
      hasPendingTasks: () => hasPendingTasksFn(),
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
