import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, HttpResponseError, type Host } from '../src/harness.ts';
import { closeJsonlSinks, initializeJsonlSinks } from '../src/log.ts';

test('retains HTTP error body for callers and JSONL without printing it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-http-'));
  const payload = 'private response body';
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(payload, { status: 503 })
  );
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const host: Host = {
    version: 'v1',
    url: 'http://127.0.0.1',
    workDir: '',
    homeDir: '',
    logs: () => '',
    stop: async () => {},
  };
  try {
    initializeJsonlSinks(directory);
    let caught: unknown;
    try {
      await api(host, 'GET', '/failure');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpResponseError);
    expect((caught as HttpResponseError).body).toBe(payload);
    expect((caught as HttpResponseError).status).toBe(503);
    expect(String(caught)).not.toContain(payload);
    expect(stderr.mock.calls.flat().join('')).not.toContain(payload);
    expect(readFileSync(join(directory, 'host-v1.jsonl'), 'utf8')).toContain(payload);
  } finally {
    closeJsonlSinks();
    fetchMock.mockRestore();
    stderr.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('records complete successful V2 response without auth or human payload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-http-success-'));
  const payload = JSON.stringify({ private: 'response-body-'.repeat(1000) });
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(payload));
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const host: Host = {
    version: 'v2',
    url: 'http://127.0.0.1',
    workDir: '',
    homeDir: '',
    logs: () => '',
    stop: async () => {},
  };
  try {
    initializeJsonlSinks(directory);
    expect(await api(host, 'GET', '/success')).toEqual(JSON.parse(payload));
    const records = readFileSync(join(directory, 'host-v2.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.find((record) => record.sourceId === 'harness.api.response-payload')
    ).toMatchObject({
      level: 'trace',
      payload,
      status: 200,
    });
    expect(readFileSync(join(directory, 'host-v1.jsonl'), 'utf8')).toBe('');
    expect(stderr.mock.calls.flat().join('')).not.toContain('response-body-');
  } finally {
    closeJsonlSinks();
    fetchMock.mockRestore();
    stderr.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
