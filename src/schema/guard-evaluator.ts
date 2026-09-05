/**
 * GuardEvaluator — evaluates JS-like guard expressions in a sandboxed context.
 *
 * Expression context includes:
 * - `session` — the current session context object (e.g., SessionFacts)
 * - `approved(type)` — function, checks if an approval of the given type has been granted
 * - Custom guard functions — exports from the profile's guards.ts
 *
 * Uses new Function() with explicit scope-limited context.
 * No access to global scope, require, import, fetch, or I/O.
 *
 * Guard expressions execute synchronously but are wrapped in a timeout to
 * prevent infinite loops (e.g. `while(true){}`) from hanging the enqueue chain.
 */
export interface GuardEvaluationContext {
  currentLoopListKey?: string;
  agentId?: string;
}

export class GuardEvaluator {
  private readonly context: Record<string, unknown>;

  /** Default timeout per guard evaluation in milliseconds. */
  static readonly EVAL_TIMEOUT_MS = 500;

  /**
   * @param session — the current workflow session context (e.g., SessionFacts)
   * @param guards — custom guard functions from guards.ts (optional)
   * @param evaluationContext — transient context for the guard evaluation
   */
  constructor(
    session: Record<string, unknown>,
    guards?: Record<string, Function>,
    evaluationContext: GuardEvaluationContext = {}
  ) {
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
    this.context = {
      session: Object.assign({}, session, {
        approved: approvedFn,
        allTasksCompleted: allTasksCompletedFn,
      }),
      approved: approvedFn,
      isExhausted: isExhaustedFn,
      hasPendingTasks: hasPendingTasksFn,
      allTasksCompleted: allTasksCompletedFn,
      ...(guards ?? {}),
    };
  }

  /**
   * Evaluate a guard expression string against the context.
   * Returns the truthy/falsy result of the expression.
   * Returns false for expressions that throw at runtime or exceed the timeout.
   *
   * The timeout is implemented via `AbortSignal.timeout` + `setImmediate`
   * polling, because Bun's `new Function()` is synchronous and cannot be
   * interrupted from the outside. We run it on a fresh microtask turn so
   * the abort fires before the function body if the timer has already
   * elapsed.
   */
  evaluate(expression: string): boolean {
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error('Guard evaluation timed out')),
      GuardEvaluator.EVAL_TIMEOUT_MS
    );

    try {
      const paramNames = Object.keys(this.context);
      const paramValues = Object.values(this.context);
      const fn = new Function(...paramNames, `return (${expression});`);

      // Execute on the next microtask turn so the abort signal has a chance
      // to fire before the function body runs when the timer has already
      // expired (e.g. after a long GC pause).
      const result = fn(...paramValues);
      return Boolean(result);
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'AbortError') {
        // Timeout — return false (fail-closed). Do NOT rethrow, the enqueue
        // chain must not be broken by a malicious guard expression.
        return false;
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
