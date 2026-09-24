import type { LogFn } from './logger.ts';

/**
 * One funnel for every error the plugin reports.
 *
 * The three channels existed and were used once each, wired independently:
 * a toast gated on `DEBUG_TUI`, a log gated on `SESSION_GUARD_LOG_LEVEL`, and
 * a refusal carried by `WorkflowBlockedError`. Two switches for one idea of
 * "debug", and what the operator saw depended on which tool they happened to
 * call — the same `ProfileConfigurationError` became tool output in
 * `workflow-tasks-get` and escaped `workflow-tasks-set` raw.
 *
 * The rule is now one rule: an error reaches the operator as readable text,
 * always goes to the log, and shows as a toast when debug is on. The text is
 * what the caller returns or throws; this is the other two.
 */
export type Reporter = (_message: string, _extra?: Record<string, unknown>) => void;

/** The one debug switch. `DEBUG_TUI` is honoured only to turn toasts off. */
export function toastsEnabled(): boolean {
  if (process.env.DEBUG_TUI === '0') return false;
  return process.env.SESSION_GUARD_LOG_LEVEL === 'debug';
}

type ToastClient = {
  post?: (
    _path: string,
    _input: { body: { message: string; variant: 'error' } }
  ) => Promise<unknown>;
};

export function createReporter(client: ToastClient, log: LogFn): Reporter {
  return (message, extra) => {
    void log('error', message, extra);
    if (!toastsEnabled()) return;
    void client.post?.('/tui/show-toast', { body: { message, variant: 'error' } })?.catch(() => {});
  };
}

/** The message an error carries, whatever shape it arrived in. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
