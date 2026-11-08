import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('routes complete JSONL records independently of human filtering', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-logger-test-'));
  try {
    const modulePath = new URL('../src/log.ts', import.meta.url).pathname;
    const script = `
      import { initializeJsonlSinks, closeJsonlSinks, log } from ${JSON.stringify(modulePath)};
      initializeJsonlSinks(${JSON.stringify(directory)});
      log('debug', 'debug\\nline', { sourceId: 'suite.debug', fields: { sourceId: 'spoof' } });
      log('error', 'private payload', { sourceId: 'v1.payload', sink: 'host-v1', human: false });
      log('warn', 'v2 payload', { sourceId: 'v2.payload', sink: 'host-v2' });
      log('error', 'visible', { sourceId: 'suite.error', label: ' label ' });
      closeJsonlSinks();
      closeJsonlSinks();
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      env: { ...process.env, HOST_SMOKE_LOG_LEVEL: 'error' },
    });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain('visible');
    expect(stderr).not.toContain('private payload');
    expect(stderr).not.toContain('debug');
    expect(stderr).not.toContain('v2 payload');
    const events = (sink: string): Record<string, unknown>[] =>
      readFileSync(join(directory, `${sink}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events('suite')).toMatchObject([
      { sourceId: 'suite.debug', message: 'debug\nline', level: 'debug' },
      { sourceId: 'suite.error', message: 'visible', label: 'label' },
    ]);
    expect(events('host-v1')).toMatchObject([
      { sourceId: 'v1.payload', message: 'private payload' },
    ]);
    expect(events('host-v2')).toMatchObject([{ sourceId: 'v2.payload', message: 'v2 payload' }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('V1 exchange shows full human output only at debug and records the full prompt in JSONL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-exchange-test-'));
  try {
    const exchange = new URL('../src/host/v1-exchange.ts', import.meta.url).pathname;
    const logger = new URL('../src/log.ts', import.meta.url).pathname;
    const prompt = `prompt start\n${'prompt-'.repeat(1000)}\nprompt end`;
    const response = `response start\n${'response-'.repeat(1000)}\nresponse end`;
    const error = 'model error detail';
    const script = `
      import { logExchange } from ${JSON.stringify(exchange)};
      import { initializeJsonlSinks, closeJsonlSinks } from ${JSON.stringify(logger)};
      initializeJsonlSinks(${JSON.stringify(directory)});
      logExchange(${JSON.stringify(prompt)}, 'agent', [{ type: 'text', text: ${JSON.stringify(response)} }], ${JSON.stringify(error)});
      closeJsonlSinks();
    `;
    for (const level of ['debug', 'info']) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        env: { ...process.env, HOST_SMOKE_LOG_LEVEL: level },
      });
      expect(result.exitCode).toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr.includes('USER:')).toBe(level === 'debug');
      expect(stderr.includes('MODEL:')).toBe(level === 'debug');
      for (const text of [prompt, response, error]) {
        expect(stderr.includes(text)).toBe(level === 'debug');
      }
      const jsonl = readFileSync(join(directory, 'host-v1.jsonl'), 'utf8');
      const events = jsonl
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toMatchObject([
        {
          sourceId: 'v1-exchange.summary',
          level: 'debug',
          agent: 'agent',
          instruction: prompt,
          instructionLength: prompt.length,
          partCount: 1,
          message: `USER: ${prompt}; MODEL: 1 parts`,
        },
      ]);
      for (const text of [response, error]) expect(jsonl).not.toContain(text);
      for (const sink of ['suite', 'host-v1', 'host-v2']) {
        rmSync(join(directory, `${sink}.jsonl`));
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
