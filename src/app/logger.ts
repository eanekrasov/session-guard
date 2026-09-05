import type { PluginInput } from '@opencode-ai/plugin';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const EFFECTIVE_LEVEL: LogLevel =
  process.env.STATE_MACHINE_LOG_LEVEL === 'debug'
    ? 'debug'
    : process.env.STATE_MACHINE_LOG_LEVEL === 'info'
      ? 'info'
      : process.env.STATE_MACHINE_LOG_LEVEL === 'warn'
        ? 'warn'
        : process.env.STATE_MACHINE_LOG_LEVEL === 'error'
          ? 'error'
          : 'info';

export type LogFn = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
) => Promise<void>;

/**
 * Create a LogFn backed by client.app.log().
 * Respects STATE_MACHINE_LOG_LEVEL env var — messages below the threshold
 * are silently dropped.
 */
export function createLogFn(client: PluginInput['client']): LogFn {
  return async (level, message, extra) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[EFFECTIVE_LEVEL]) return;

    try {
      await client.app.log({
        body: { service: 'state-machine', level, message, extra: extra ?? {} },
      });
    } catch {
      // ignore — logging must never throw
    }
  };
}
