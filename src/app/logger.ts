import type { PluginInput } from '@opencode-ai/plugin';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const EFFECTIVE_LEVEL: LogLevel =
  process.env.SESSION_GUARD_LOG_LEVEL === 'debug'
    ? 'debug'
    : process.env.SESSION_GUARD_LOG_LEVEL === 'info'
      ? 'info'
      : process.env.SESSION_GUARD_LOG_LEVEL === 'warn'
        ? 'warn'
        : process.env.SESSION_GUARD_LOG_LEVEL === 'error'
          ? 'error'
          : 'info';

export type LogFn = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
) => Promise<void>;

/** A LogFn that discards everything — the default when a caller wires none. */
export const noopLog: LogFn = () => Promise.resolve();

/**
 * Create a LogFn backed by client.app.log().
 * Respects SESSION_GUARD_LOG_LEVEL env var — messages below the threshold
 * are silently dropped.
 */
export function createLogFn(client: PluginInput['client']): LogFn {
  return async (level, message, extra) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[EFFECTIVE_LEVEL]) return;

    try {
      await client.app.log({
        body: { service: 'session-guard', level, message, extra: extra ?? {} },
      });
    } catch {
      // ignore — logging must never throw
    }
  };
}

/**
 * Create a LogFn backed by the console.
 *
 * Standalone entry points run outside OpenCode and hold no client to log
 * through — the dashboard server is its own process. Same level threshold and
 * formatting as the plugin logger, so both surfaces read alike.
 */
export function createConsoleLogFn(): LogFn {
  return async (level, message, extra) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[EFFECTIVE_LEVEL]) return;

    const prefix = level === 'error' ? '[ERROR] ' : level === 'warn' ? '[WARN] ' : '';
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : '';
    // eslint-disable-next-line no-console
    console.log(`${new Date().toISOString()} ${prefix}${message}${extraStr}`);
  };
}
