#!/usr/bin/env bun
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const usage = `Usage: bun run smoke/src/parse-jsonl.ts <file> [--level <level>] [--fields <field,...>]

Filters by exact level (trace, debug, info, warn, error) and projects top-level fields.
Output is JSONL on stdout. Exit codes: 0 success, 1 input error, 2 invalid arguments.`;
const levels = ['trace', 'debug', 'info', 'warn', 'error'];

async function main(args: string[]): Promise<number> {
  let file: string | undefined;
  let level: string | undefined;
  let fields: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${usage}\n`);
      return 0;
    }
    const option = arg.split('=', 1)[0];
    if (option === '--level' || option === '--fields') {
      const value = arg.includes('=') ? arg.slice(option.length + 1) : args[++i];
      if (!value || value.startsWith('--')) return argumentError(`${option} needs a value`);
      if (option === '--level') {
        if (!levels.includes(value)) return argumentError(`invalid level: ${value}`);
        level = value;
      } else {
        fields = value.split(',');
        if (fields.some((field) => !field.trim())) return argumentError('invalid fields');
        fields = fields.map((field) => field.trim());
      }
    } else if (arg.startsWith('-')) {
      return argumentError(`unknown argument: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      return argumentError(`unexpected argument: ${arg}`);
    }
  }
  if (!file) return argumentError('input file is required');

  let lineNumber = 0;
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber++;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON at line ${lineNumber}`);
      }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error(`expected an object at line ${lineNumber}`);
      }
      const record = event as Record<string, unknown>;
      if (level !== undefined && record.level !== level) continue;
      const result = fields
        ? Object.fromEntries(
            fields
              .filter((field) => Object.hasOwn(record, field))
              .map((field) => [field, record[field]])
          )
        : record;
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `parse-jsonl: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

function argumentError(message: string): number {
  process.stderr.write(`parse-jsonl: ${message}\n\n${usage}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
