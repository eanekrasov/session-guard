import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { logProcessOutput } from '../src/host/process-output.ts';
import { closeJsonlSinks, initializeJsonlSinks } from '../src/log.ts';

test('routes synthetic process streams to both host sinks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-process-'));
  try {
    initializeJsonlSinks(directory);
    for (const version of ['v1', 'v2'] as const) {
      const marker = `synthetic-process-${version}-`;
      const child = spawn(process.execPath, [
        '-e',
        `const b = Buffer.from('${marker}héllo\\n${marker}last');
         const cut = b.indexOf('é') + 1;
         process.stdout.write(b.subarray(0, cut));
         process.stderr.write('${marker}error\\n${marker}partial');
         setTimeout(() => process.stdout.write(b.subarray(cut)), 30);`,
      ]);
      logProcessOutput(child.stdout!, 'stdout', version, () => {});
      logProcessOutput(child.stderr!, 'stderr', version, () => {});
      expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(0);
    }
    closeJsonlSinks();
    for (const version of ['v1', 'v2'] as const) {
      const marker = `synthetic-process-${version}-`;
      for (const sink of ['v1', 'v2'] as const) {
        const records = readFileSync(join(directory, `host-${sink}.jsonl`), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (record) =>
              record.sourceId === 'harness.child.output' &&
              ['process.stdout', 'process.stderr'].includes(record.type) &&
              record.message.startsWith(marker)
          );
        expect(records.map((record) => [record.type, record.message]).sort()).toEqual(
          sink === version
            ? [
                ['process.stderr', `${marker}error\n`],
                ['process.stderr', `${marker}partial`],
                ['process.stdout', `${marker}héllo\n`],
                ['process.stdout', `${marker}last`],
              ].sort()
            : []
        );
      }
    }
  } finally {
    closeJsonlSinks();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parses process logfmt without overwriting the JSONL envelope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-process-logfmt-'));
  try {
    initializeJsonlSinks(directory);
    const child = spawn(process.execPath, [
      '-e',
      `process.stderr.write(${JSON.stringify('timestamp=2025-01-02T03:04:05Z level=INFO type=event message="hello \\"world\\"" path=/tmp/a count=42 mixed=plain quoted="a\\\\b"\n')});
       process.stderr.write(${JSON.stringify('not logfmt output\n')});`,
    ]);
    logProcessOutput(child.stderr!, 'stderr', 'v1', () => {});
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(0);
    closeJsonlSinks();

    const records = readFileSync(join(directory, 'host-v1.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.sourceId === 'harness.child.output');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 'debug',
      type: 'process.stderr',
      timestamp: expect.any(String),
      sourceId: 'harness.child.output',
      message:
        'timestamp=2025-01-02T03:04:05Z level=INFO type=event message="hello \\"world\\"" path=/tmp/a count=42 mixed=plain quoted="a\\\\b"\n',
      stream: 'stderr',
      version: 'v1',
      processLog: {
        timestamp: '2025-01-02T03:04:05Z',
        level: 'info',
        type: 'event',
        message: 'hello "world"',
        path: '/tmp/a',
        count: '42',
        mixed: 'plain',
        quoted: 'a\\b',
      },
    });
    expect(records[1].processLog).toEqual({ raw: 'not logfmt output\n' });
    expect(records[1].message).toBe('not logfmt output\n');
  } finally {
    closeJsonlSinks();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parses stderr logfmt split across chunks and without a trailing newline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-process-logfmt-chunks-'));
  const stream = new PassThrough();
  try {
    initializeJsonlSinks(directory);
    logProcessOutput(stream, 'stderr', 'v2', () => {});
    const ended = new Promise<void>((resolve) => stream.once('end', resolve));
    stream.write('level=INFO message="split ');
    stream.end('message" path=/tmp/example');
    await ended;
    closeJsonlSinks();

    const [record] = readFileSync(join(directory, 'host-v2.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(record).toMatchObject({
      type: 'process.stderr',
      message: 'level=INFO message="split message" path=/tmp/example',
      processLog: { level: 'info', message: 'split message', path: '/tmp/example' },
    });
  } finally {
    closeJsonlSinks();
    rmSync(directory, { recursive: true, force: true });
  }
});
