import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Слой вывода suite: один цвет на вид события или JSONL, когда данные читает машина.
 */

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
  sourceId: string;
  sink?: 'suite' | 'host-v1' | 'host-v2';
  human?: boolean;
  humanMessage?: string;
  color?: LogColor;
  type?: string;
  fields?: Record<string, unknown>;
  label?: string;
}

let sinks: Partial<Record<NonNullable<LogOptions['sink']>, number>> = {};

export function initializeJsonlSinks(directory: string): void {
  closeJsonlSinks();
  try {
    for (const sink of ['suite', 'host-v1', 'host-v2'] as const) {
      sinks[sink] = openSync(join(directory, `${sink}.jsonl`), 'wx', 0o600);
    }
  } catch (error) {
    closeJsonlSinks();
    throw error;
  }
}

export function closeJsonlSinks(): void {
  const openSinks = sinks;
  sinks = {};
  for (const fd of Object.values(openSinks)) closeSync(fd);
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

/** Write every event to its JSONL sink and filter only human output. */
export function log(level: LogLevel, message: string, options: LogOptions): void {
  const { sourceId, sink = 'suite', human = true, type = 'message', fields = {} } = options;
  const event = formatJsonlEvent({
    ...fields,
    timestamp: new Date().toISOString(),
    level,
    type,
    sourceId,
    ...(options?.label === undefined ? {} : { label: options.label.trim() }),
    message,
  });
  const fd = sinks[sink];
  if (fd !== undefined) writeSync(fd, event);
  if (!human || LOG_LEVELS[level] < LOG_LEVELS[configuredLogLevel()]) return;

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] `;
  const color = options?.color ?? LEVEL_COLORS[level];
  const humanMessage = options.humanMessage ?? message;
  const body = options?.label === undefined ? humanMessage : `${options.label}\n${humanMessage}`;
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
