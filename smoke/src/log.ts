/**
 * Слой вывода suite: один цвет на вид события или JSONL, когда данные читает машина.
 */

export const OUTPUT_FORMAT = process.env.HOST_SMOKE_OUTPUT ?? 'human';
export const ANSI = {
  reset: '\u001b[0m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  green: '\u001b[32m',
  magenta: '\u001b[35m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
} as const;

export type LogColor = keyof Omit<typeof ANSI, 'reset'>;

export function colorize(text: string, color: LogColor): string {
  const enabled =
    process.env.NO_COLOR === undefined &&
    (Boolean(process.env.FORCE_COLOR) || process.stderr.isTTY);
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

/** Записать одно цельное событие, чтобы параллельный опрос `question` не разбил его. */
export function logEvent(
  text: string,
  color?: LogColor,
  type = 'message',
  fields: Record<string, unknown> = {}
): void {
  if (OUTPUT_FORMAT === 'jsonl') {
    process.stderr.write(
      formatJsonlEvent({ ...fields, timestamp: new Date().toISOString(), type, message: text })
    );
    return;
  }
  process.stderr.write(`${color ? colorize(text, color) : text}\n`);
}

export interface SmokeEvent {
  timestamp: string;
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

export function logBlock(label: string, text: string, color: LogColor, type: string): void {
  if (OUTPUT_FORMAT === 'jsonl') {
    logEvent(text, undefined, type, { label: label.trim() });
    return;
  }
  logEvent(`${colorize(label, color)}\n${text}`);
}
