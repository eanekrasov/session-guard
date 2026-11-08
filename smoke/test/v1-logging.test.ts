import { expect, spyOn, test } from 'bun:test';
import type { Host } from '../src/harness.ts';
import * as logger from '../src/log.ts';
import { subscribeToV1Events } from '../src/host/v1-exchange.ts';
import { createLegacyHttpTransport } from '../src/host/v1-transport.ts';

test('V1 records complete SSE data once, including malformed and trailing records', async () => {
  const originalFetch = globalThis.fetch;
  const log = spyOn(logger, 'log').mockImplementation(() => {});
  const payload = 'x'.repeat(5000);
  const first = `data: ${JSON.stringify({ type: 'test', properties: { payload } })}`;
  const malformed = 'data: {broken';
  const last = `data: ${JSON.stringify({ type: 'last', properties: { payload } })}`;
  const events: unknown[] = [];
  globalThis.fetch = Object.assign(
    async () => new Response(`${first}\n\n${malformed}\n\n${last}`),
    {
      preconnect: originalFetch.preconnect,
    }
  ) as typeof fetch;
  try {
    const subscription = subscribeToV1Events({ url: 'http://example.invalid' } as Host, (event) => {
      events.push(event);
    });
    expect(await subscription.done).toBeUndefined();
    expect(events).toEqual([
      { type: 'test', data: { payload } },
      { type: 'last', data: { payload } },
    ]);
    expect(log.mock.calls.map((call) => call[2])).toEqual(
      [first, malformed, last].map((record) => ({
        sourceId: 'v1-exchange.sse-record',
        sink: 'host-v1',
        human: false,
        type: 'sse.event',
        fields: { record },
      }))
    );
  } finally {
    globalThis.fetch = originalFetch;
    log.mockRestore();
  }
});

test('V1 logs full prompt and response as structured payloads', async () => {
  const originalFetch = globalThis.fetch;
  const log = spyOn(logger, 'log').mockImplementation(() => {});
  const prompt = 'prompt-'.repeat(1000);
  const response = `<task id="child-123" state="completed"><task_result>${'response-'.repeat(1000)}</task_result></task>`;
  const error = 'model failure';
  let sent = false;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/session' && init?.method === 'POST') return Response.json({ id: 'ses-1' });
      if (path === '/event') {
        return new Response(
          `data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 'ses-1', status: { type: 'idle' } } })}\n\n`
        );
      }
      if (path.endsWith('/message') && init?.method === 'POST') {
        sent = true;
        return Response.json({
          info: { error: { data: { message: error } } },
          parts: [{ type: 'text', text: response }],
          extra: 'reply metadata',
        });
      }
      if (path.endsWith('/message')) {
        return Response.json(
          sent ? [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: response }] }] : []
        );
      }
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect }
  ) as typeof fetch;
  try {
    const host = { url: 'http://example.invalid', homeDir: '/nonexistent' } as Host;
    const transport = createLegacyHttpTransport(host, { model: 'provider/model' });
    const session = await transport.createSession('test');
    await transport.prompt(session, { text: prompt });
    await transport.removeSession(session);
    const request = log.mock.calls.find((call) => call[2]?.type === 'v1.message-request')?.[2];
    const reply = log.mock.calls.find((call) => call[2]?.type === 'v1.message-response')?.[2];
    const requestSummary = log.mock.calls.find(
      (call) => call[2]?.sourceId === 'v1-transport.request-summary'
    );
    const exchangeSummary = log.mock.calls.find(
      (call) => call[2]?.sourceId === 'v1-exchange.summary'
    );
    expect(log.mock.calls.find((call) => call[2]?.type === 'v1.message-request')?.[0]).toBe(
      'trace'
    );
    expect(request).toMatchObject({
      sink: 'host-v1',
      human: false,
      fields: {
        model: 'provider/model',
        instruction: prompt,
        instructionLength: prompt.length,
      },
    });
    expect(requestSummary?.[1]).toContain(prompt);
    expect(requestSummary?.[2]).toMatchObject({
      humanMessage: expect.stringContaining(prompt),
      fields: { instruction: prompt, instructionLength: prompt.length },
    });
    expect(reply).toMatchObject({
      sink: 'host-v1',
      human: false,
      fields: { sessionID: 'ses-1', responseLength: error.length + 1 + response.length },
    });
    expect(exchangeSummary?.[1]).toContain(prompt);
    expect(exchangeSummary?.[2]).toMatchObject({
      fields: { instruction: prompt, instructionLength: prompt.length },
      humanMessage: `USER:\n${prompt}\nMODEL:\n${error}\n${response}`,
    });
    expect(JSON.stringify(request)).toContain(prompt);
    expect(JSON.stringify(reply)).not.toContain(response);
    const requestPayload = log.mock.calls.find(
      (call) =>
        call[2]?.sourceId === 'harness.api.request-payload' &&
        JSON.stringify(call[2]).includes(prompt)
    );
    const responsePayload = log.mock.calls.find(
      (call) =>
        call[2]?.sourceId === 'harness.api.response-payload' &&
        JSON.stringify(call[2]).includes('response-'.repeat(100))
    );
    expect(JSON.stringify(requestPayload)).toContain(prompt);
    expect(JSON.stringify(responsePayload)).toContain('response-'.repeat(100));
    const child = log.mock.calls.find((call) => call[2]?.type === 'v1.child-response')?.[2];
    expect(child?.fields).toMatchObject({
      childSessionID: 'child-123',
      messageCount: 1,
      roles: ['assistant'],
    });
    expect(JSON.stringify(child)).not.toContain(response);
  } finally {
    globalThis.fetch = originalFetch;
    log.mockRestore();
  }
});
