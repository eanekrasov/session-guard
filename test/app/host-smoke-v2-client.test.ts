import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createV2SmokeTransport,
  runV2WorkflowCreate,
  type V2SmokeClient,
} from '../../scripts/host-smoke/v2-client.ts';
import type { Host } from '../../scripts/host-smoke/harness.ts';

describe('V2 host smoke adapter', () => {
  test('normalizes missing JSON content type on successful V2 responses', async () => {
    let response: Response | undefined;
    const transport = createV2SmokeTransport();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response('{}', { status: 200 }), {
      preconnect: originalFetch.preconnect,
    });
    try {
      response = await transport('http://127.0.0.1:1');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(response?.headers.get('content-type')).toBe('application/json');
  });

  test('does not relabel a non-JSON response', async () => {
    const transport = createV2SmokeTransport();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response('not json', { status: 200 }), {
      preconnect: originalFetch.preconnect,
    });
    let response: Response | undefined;
    try {
      response = await transport('http://127.0.0.1:1');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(response?.headers.get('content-type')).toBeNull();
  });

  test('waits for the V2 prompt, reads durable workflow state, and disposes the session', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'v2-smoke-home-'));
    const sessionId = 'v2-session';
    const calls: string[] = [];
    const client: V2SmokeClient = {
      async createSession(title) {
        calls.push(`create:${title}`);
        return sessionId;
      },
      async prompt(id, text) {
        calls.push(`prompt:${id}:${text}`);
      },
      async removeSession(id) {
        calls.push(`remove:${id}`);
      },
    };
    const host = {
      homeDir,
      logs: () => '',
      stop: async () => {},
      url: 'http://127.0.0.1:0',
      workDir: homeDir,
    } satisfies Host;
    const runtime = join(homeDir, 'data', 'opencode', 'session-guard', 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, `${sessionId}.json`), '{"currentStage":"planning"}');

    try {
      await expect(runV2WorkflowCreate(client, host, 'create workflow')).resolves.toEqual({
        sessionId,
        state: { currentStage: 'planning' },
      });
      expect(calls).toEqual([
        'create:v2-workflow-create',
        'prompt:v2-session:create workflow',
        'remove:v2-session',
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('disposes the V2 session when prompt completion fails', async () => {
    const calls: string[] = [];
    const client: V2SmokeClient = {
      async createSession() {
        return 'failed-session';
      },
      async prompt() {
        throw new Error('model unavailable');
      },
      async removeSession(id) {
        calls.push(id);
      },
    };
    const host = {
      homeDir: tmpdir(),
      logs: () => '',
      stop: async () => {},
      url: 'http://127.0.0.1:0',
      workDir: tmpdir(),
    } satisfies Host;

    await expect(runV2WorkflowCreate(client, host, 'create workflow')).rejects.toThrow(
      'model unavailable'
    );
    expect(calls).toEqual(['failed-session']);
  });
});
