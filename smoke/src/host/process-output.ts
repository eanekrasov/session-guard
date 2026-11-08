import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { decode } from '@jclem/logfmt2';
import { log } from '../log.ts';

export function logProcessOutput(
  input: Readable,
  stream: 'stdout' | 'stderr',
  version: 'v1' | 'v2',
  onText: (text: string) => void
): void {
  captureProcessOutput(input, onText, (content) =>
    log('debug', content, {
      sourceId: 'harness.child.output',
      sink: version === 'v1' ? 'host-v1' : 'host-v2',
      human: false,
      type: `process.${stream}`,
      fields: {
        stream,
        version,
        ...(stream === 'stderr' ? { processLog: parseLogfmt(content) ?? { raw: content } } : {}),
      },
    })
  );
}

function parseLogfmt(line: string): Record<string, string> | undefined {
  const input = line.replace(/[\r\n]+$/, '');
  // decode() is the parser; fall back when its known lossy cases could corrupt diagnostics.
  if (/\t|(?:^| )__proto__=|(^|[^\\])\\[^"\\]/.test(input)) return undefined;
  const decoded = decode(input);
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(decoded)) {
    if (typeof value !== 'string') return undefined;
    fields[key] = value;
  }
  if (Object.keys(fields).length === 0 || !input.includes('=')) return undefined;
  if (typeof fields.level === 'string') fields.level = fields.level.toLowerCase();
  return fields;
}

export function captureProcessOutput(
  input: Readable,
  onText: (text: string) => void,
  onRecord: (record: string) => void
): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const accept = (text: string): void => {
    onText(text);
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      onRecord(pending.slice(0, newline + 1));
      pending = pending.slice(newline + 1);
    }
  };
  input.on('data', (chunk: Buffer) => accept(decoder.write(chunk)));
  input.on('end', () => {
    accept(decoder.end());
    if (pending !== '') onRecord(pending);
  });
}
