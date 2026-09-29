const SENSITIVE_KEY =
  /(token|secret|password|credential|authorization|cookie|content|prompt|body)/i;
const MAX_STRING_LENGTH = 160;
const MAX_KEYS = 24;

export type ToolTraceInput = Record<string, unknown>;

export function summarizeToolInput(input: ToolTraceInput): Record<string, unknown> {
  return compactRecord(input);
}

export function summarizeToolArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return { type: typeof args };
  return compactRecord(args);
}

export function errorTrace(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: truncate(error.message) };
  }
  return { name: typeof error, message: truncate(String(error)) };
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value).slice(0, MAX_KEYS);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : compactValue(entry),
    ])
  );
}

function compactValue(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (isRecord(value)) return { type: 'object', keys: Object.keys(value).slice(0, MAX_KEYS) };
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return typeof value;
}

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
