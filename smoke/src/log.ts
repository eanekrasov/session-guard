/**
 * Слой вывода suite: один цвет на вид события или JSONL, когда данные читает машина.
 */

export const OUTPUT_FORMAT = process.env.HOST_SMOKE_OUTPUT ?? 'human';
export const ANSI = {
  reset: '\u001b[0m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  white: '\u001b[37m',
  green: '\u001b[32m',
  magenta: '\u001b[35m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
} as const;

export type LogColor = keyof Omit<typeof ANSI, 'reset'>;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, LogColor> = {
  trace: 'cyan',
  debug: 'gray',
  info: 'white',
  warn: 'yellow',
  error: 'red',
};

export interface LogOptions {
  color?: LogColor;
  type?: string;
  fields?: Record<string, unknown>;
  label?: string;
}

export function configuredLogLevel(): LogLevel {
  const configured = process.env.HOST_SMOKE_LOG_LEVEL?.toLowerCase();
  if (
    configured === 'trace' ||
    configured === 'debug' ||
    configured === 'info' ||
    configured === 'warn' ||
    configured === 'error'
  ) {
    return configured;
  }
  if (configured === '1') return 'debug';
  return 'info';
}

export function colorize(text: string, color: LogColor): string {
  const enabled =
    process.env.NO_COLOR === undefined &&
    (Boolean(process.env.FORCE_COLOR) || process.stderr.isTTY);
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

/** Записать одно отфильтрованное событие в human- или JSONL-формате. */
export function log(level: LogLevel, message: string, options: LogOptions = {}): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[configuredLogLevel()]) return;

  const type = options.type ?? 'message';
  const fields = options.fields ?? {};
  if (OUTPUT_FORMAT === 'jsonl') {
    process.stderr.write(
      formatJsonlEvent({
        ...fields,
        timestamp: new Date().toISOString(),
        level,
        type,
        ...(options.label === undefined ? {} : { label: options.label.trim() }),
        message,
      })
    );
    return;
  }

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] `;
  const color = options.color ?? LEVEL_COLORS[level];
  const body = options.label === undefined ? message : `${options.label}\n${message}`;
  process.stderr.write(`${colorize(`${line}${body}`, color)}\n`);
}

export interface SmokeEvent {
  timestamp: string;
  level: LogLevel;
  type: string;
  message: string;
  [field: string]: unknown;
}

/**
 * Одна машинно-читаемая строка. Многострочные сообщения пользователя, модели и
 * доказательства остаются корректными JSON-строками, поэтому поток JSONL не рвётся.
 */
export function formatJsonlEvent(event: SmokeEvent): string {
  return `${JSON.stringify(event)}\n`;
}
