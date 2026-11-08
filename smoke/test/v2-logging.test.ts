import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeJsonlSinks, initializeJsonlSinks } from '../src/log.ts';
import { createV2SmokeClient } from '../src/v2-client.ts';
import { createSessionClientTransport } from '../src/host/v2-transport.ts';

test('V2 records raw SSE and persisted messages without filtering or duplicate serialization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'v2-log-test-'));
  const originalFetch = globalThis.fetch;
  const rawEvents = [
    { type: 'unrelated.event', data: { payload: 'x'.repeat(4000) } },
    { type: 'session.execution.started', data: { sessionID: 'ses-1' } },
    { type: 'session.execution.succeeded', data: { sessionID: 'ses-1' } },
  ];
  const messages = [{ type: 'assistant', extra: 'raw-only', content: [] }];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).includes('/event')) {
        return new Response(
          rawEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          }
        );
      }
      const data = String(input).includes('/message') ? messages : {};
      return new Response(JSON.stringify({ data }), {
        headers: { 'content-type': 'application/json' },
      });
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    initializeJsonlSinks(directory);
    const client = createV2SmokeClient({
      version: 'v2',
      url: 'http://127.0.0.1:1',
      workDir: process.cwd(),
      homeDir: process.cwd(),
      logs: () => '',
      stop: async () => {},
    });
    await client.prompt('ses-1', 'go');
    expect(await client.listMessages('ses-1')).toEqual(messages);
    closeJsonlSinks();
    const records = readFileSync(join(directory, 'host-v2.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const sse = records.filter((record) => record.sourceId === 'v2.client.sse');
    expect(sse.map((record) => record.event)).toEqual(rawEvents);
    expect(sse.every((record) => record.message === 'V2 SSE event')).toBe(true);
    expect(records.find((record) => record.sourceId === 'v2.client.messages.raw')).toMatchObject({
      sessionId: 'ses-1',
      type: 'session.messages.raw',
      messages,
    });
    expect(readFileSync(join(directory, 'suite.jsonl'), 'utf8')).toBe('');
  } finally {
    closeJsonlSinks();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('V2 transport writes full exchange to debug stderr but not JSONL summaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'v2-human-test-'));
  const originalLevel = process.env.HOST_SMOKE_LOG_LEVEL;
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  const host = {
    version: 'v2' as const,
    url: 'http://127.0.0.1:1',
    workDir: process.cwd(),
    homeDir: directory,
    logs: () => '',
    stop: async () => {},
  };
  const client = {
    createSession: async () => 'ses-test',
    prompt: async () => {},
    removeSession: async () => {},
    listMessages: async () => [
      { type: 'user', time: { created: 1 }, content: [{ type: 'text', text: 'complete prompt' }] },
      {
        type: 'assistant',
        time: { created: 2 },
        content: [{ type: 'text', text: 'complete model response' }],
      },
    ],
    switchAgent: async () => {},
    answeredForms: () => [],
    offScript: () => [],
    lastExecution: () => null,
    lastStepEvents: () => [],
  };
  try {
    initializeJsonlSinks(directory);
    process.env.HOST_SMOKE_LOG_LEVEL = 'debug';
    await createSessionClientTransport(host, {}, () => client).prompt(
      { id: 'ses-test', hostKind: 'v2' },
      { text: 'complete prompt' }
    );
    expect(stderr).toContain('USER:\ncomplete prompt');
    expect(stderr).toContain('MODEL:\ncomplete model response');
    closeJsonlSinks();
    const records = readFileSync(join(directory, 'host-v2.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const summaries = records.filter((record) =>
      ['v2.transport.prompt', 'v2.transport.response'].includes(record.sourceId)
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.find((record) => record.sourceId === 'v2.transport.prompt')).toMatchObject({
      message: expect.stringContaining('complete prompt'),
      instruction: 'complete prompt',
      instructionLength: 'complete prompt'.length,
    });
    expect(JSON.stringify(summaries)).not.toContain('complete model response');

    stderr = '';
    process.env.HOST_SMOKE_LOG_LEVEL = 'info';
    await createSessionClientTransport(host, {}, () => client).prompt(
      { id: 'ses-test', hostKind: 'v2' },
      { text: 'complete prompt' }
    );
    expect(stderr).not.toContain('complete prompt');
    expect(stderr).not.toContain('complete model response');
  } finally {
    closeJsonlSinks();
    if (originalLevel === undefined) delete process.env.HOST_SMOKE_LOG_LEVEL;
    else process.env.HOST_SMOKE_LOG_LEVEL = originalLevel;
    process.stderr.write = originalWrite;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('V2 logs complete message parts without HTTP response events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'v2-content-'));
  const originalFetch = globalThis.fetch;
  const modelText = 'distinctive full model content';
  const messages = [
    {
      type: 'assistant',
      time: { created: 2 },
      content: [{ type: 'text', text: modelText }],
    },
  ];
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ data: messages })), {
    preconnect: originalFetch.preconnect,
  });
  const host = {
    version: 'v2' as const,
    url: 'http://127.0.0.1:1',
    workDir: process.cwd(),
    homeDir: directory,
    logs: () => '',
    stop: async () => {},
  };
  const client = {
    createSession: async () => 'ses-content',
    prompt: async () => {},
    removeSession: async () => {},
    listMessages: async () => messages,
    switchAgent: async () => {},
    answeredForms: () => [],
    offScript: () => [],
    lastExecution: () => null,
    lastStepEvents: () => [],
  };
  try {
    initializeJsonlSinks(directory);
    await createSessionClientTransport(host, {}, () => client).prompt(
      { id: 'ses-content', hostKind: 'v2' },
      { text: 'prompt' }
    );
    closeJsonlSinks();
    const records = readFileSync(join(directory, 'host-v2.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const tools = records.find((record) => record.sourceId === 'v2.transport.tools');
    expect(tools).toMatchObject({
      sessionId: 'ses-content',
      parts: expect.any(Array),
    });
    expect(tools.toolCalls).toEqual([]);
    expect(tools.parts).toEqual([{ kind: 'text', text: modelText }]);
  } finally {
    closeJsonlSinks();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
