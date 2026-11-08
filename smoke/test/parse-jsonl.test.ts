import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(import.meta.dirname, '../src/parse-jsonl.ts');
const fixture = [
  { level: 'info', sourceId: 'suite.start', message: 'started', count: 1 },
  { level: 'error', sourceId: 'host.failure', message: 'line 1\nline 2', detail: { ok: false } },
];

describe('parse-jsonl CLI', () => {
  it('reads each sink, filters and projects without changing its source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-parser-'));
    try {
      for (const name of ['suite.jsonl', 'host-v1.jsonl', 'host-v2.jsonl']) {
        const path = join(dir, name);
        const content = `${fixture.map((event) => JSON.stringify(event)).join('\n')}\n`;
        writeFileSync(path, content);
        const run = spawnSync(
          'bun',
          ['run', cli, path, '--level', 'error', '--fields=message,level,missing'],
          { encoding: 'utf8' }
        );
        expect(run.status).toBe(0);
        expect(run.stderr).toBe('');
        expect(
          run.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        ).toEqual([{ message: 'line 1\nline 2', level: 'error' }]);
        expect(readFileSync(path, 'utf8')).toBe(content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports invalid arguments and malformed input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-parser-'));
    try {
      const path = join(dir, 'synthetic.jsonl');
      writeFileSync(path, '{bad}\n');
      for (const args of [
        [],
        [path, '--level', 'invalid'],
        [path, '--unknown'],
        [path, '--fields', ''],
      ]) {
        const run = spawnSync('bun', ['run', cli, ...args], { encoding: 'utf8' });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain('Usage:');
      }
      const run = spawnSync('bun', ['run', cli, path], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('invalid JSON at line 1');
      expect(readFileSync(path, 'utf8')).toBe('{bad}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
