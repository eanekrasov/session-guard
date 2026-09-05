export type DebugEnabledCheck = () => boolean;

export function isDebugEnabled(): boolean {
  return Boolean(process.env.OPENCODE_RULES_DEBUG);
}

export type DebugLog = (message: string) => void;

export interface DebugLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createDebugLog(
  prefix = '[opencode-rules]',
  log?: DebugLogger,
  isDebugEnabledFn?: DebugEnabledCheck
): DebugLog {
  const enabled = isDebugEnabledFn ?? isDebugEnabled;
  const logger = log ?? console;
  return (message: string): void => {
    if (enabled()) {
      logger.debug(`${prefix} ${message}`);
    }
  };
}

/** Format an unknown error value into a human-readable message. */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Log a warning with the standard opencode-rules prefix. */
export function logWarning(
  context: string,
  error: unknown,
  log?: DebugLogger,
  isDebugEnabledFn?: DebugEnabledCheck
): void {
  const enabled = isDebugEnabledFn ?? isDebugEnabled;
  if (!enabled()) return;
  const logger = log ?? console;
  logger.warn(`[opencode-rules] Warning: ${context}: ${formatError(error)}`);
}

/** Log an error with the standard opencode-rules prefix. */
export function logError(
  context: string,
  error: unknown,
  log?: DebugLogger,
  isDebugEnabledFn?: DebugEnabledCheck
): void {
  const enabled = isDebugEnabledFn ?? isDebugEnabled;
  if (!enabled()) return;
  const logger = log ?? console;
  logger.error(`[opencode-rules] ${context}:`, error);
}
