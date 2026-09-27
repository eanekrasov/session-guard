/**
 * The suite's output layer: one colour per event kind, or JSONL when a machine reads it.
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

/** Write one complete event so concurrent question polling cannot split it. */
export function logEvent(
  text: string,
  color?: LogColor,
  type = 'message',
  fields: Record<string, unknown> = {}
): void {
  if (OUTPUT_FORMAT === 'jsonl') {
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), type, message: text, ...fields })}\n`
    );
    return;
  }
  process.stderr.write(`${color ? colorize(text, color) : text}\n`);
}

export function logBlock(label: string, text: string, color: LogColor, type: string): void {
  if (OUTPUT_FORMAT === 'jsonl') {
    logEvent(text, undefined, type, { label: label.trim() });
    return;
  }
  logEvent(`${colorize(label, color)}\n${text}`);
}
