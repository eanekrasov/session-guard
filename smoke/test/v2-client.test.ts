import { describe, expect, test } from 'bun:test';

import { createV2SmokeClient, createV2SmokeTransport, planFormAnswer } from '../src/v2-client.ts';
import type { Host } from '../src/harness.ts';

/** Минимальные формы: план ответа читает только `type`, `key`, `label` и `value`. */
const stringField = (key: string, options?: Array<{ label: string; value: string }>) =>
  ({ key, type: 'string', title: key, ...(options ? { options } : {}) }) as never;
const multiselectField = (key: string, options: Array<{ label: string; value: string }>) =>
  ({ key, type: 'multiselect', title: key, options }) as never;
const booleanField = (key: string, fallback?: boolean) =>
  ({
    key,
    type: 'boolean',
    title: key,
    ...(fallback === undefined ? {} : { default: fallback }),
  }) as never;

const GRANT_DECLINE = [
  { label: 'grant', value: 'provider-granted' },
  { label: 'decline', value: 'provider-declined' },
];

describe('V2 host smoke transport', () => {
  test('normalizes missing JSON content type on a successful response', async () => {
    const transport = createV2SmokeTransport();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response('{}', { status: 200 }), {
      preconnect: originalFetch.preconnect,
    });
    try {
      const response = await transport('http://127.0.0.1:1');
      expect(response?.headers.get('content-type')).toBe('application/json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not relabel a non-JSON response', async () => {
    const transport = createV2SmokeTransport();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response('not json', { status: 200 }), {
      preconnect: originalFetch.preconnect,
    });
    try {
      const response = await transport('http://127.0.0.1:1');
      expect(response?.headers.get('content-type')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends the credential the V2 host generated for itself', async () => {
    const transport = createV2SmokeTransport('Basic abc');
    const originalFetch = globalThis.fetch;
    let seen: Headers | undefined;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      await transport('http://127.0.0.1:1');
      expect(seen?.get('authorization')).toBe('Basic abc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('leaves a caller-supplied authorization header alone', async () => {
    const transport = createV2SmokeTransport('Basic abc');
    const originalFetch = globalThis.fetch;
    let seen: Headers | undefined;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      await transport('http://127.0.0.1:1', { headers: { authorization: 'Bearer own' } });
      expect(seen?.get('authorization')).toBe('Bearer own');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('the operator answer for one form', () => {
  test('answers the consent form with the option value behind the label', () => {
    const plan = planFormAnswer(
      {
        title: '<consent-request type="plan">approve?</consent-request>',
        fields: [stringField('decision', GRANT_DECLINE)],
      },
      'grant'
    );

    expect(plan.answer).toEqual({ decision: 'provider-granted' });
    expect(plan.offScript).toEqual([]);
  });

  test('declines the consent form when the scenario asked it to', () => {
    const plan = planFormAnswer(
      {
        title: '<consent-request type="plan">approve?</consent-request>',
        fields: [stringField('decision', GRANT_DECLINE)],
      },
      'decline'
    );

    expect(plan.answer).toEqual({ decision: 'provider-declined' });
  });

  test('finds the consent tag in a field description, not only in the title', () => {
    const plan = planFormAnswer(
      {
        title: 'Approve the plan?',
        fields: [
          {
            key: 'decision',
            type: 'string',
            title: 'decision',
            description: '<consent-request type="plan">approve?</consent-request>',
            options: GRANT_DECLINE,
          } as never,
        ],
      },
      'decline'
    );

    expect(plan.answer).toEqual({ decision: 'provider-declined' });
  });

  test('prefers a declining option for a question the scenario never asked', () => {
    const plan = planFormAnswer(
      {
        title: 'How would you like to proceed?',
        fields: [
          stringField('choice', [
            { label: 'Yes, continue', value: 'yes' },
            { label: 'No, stop here', value: 'no' },
          ]),
        ],
      },
      'grant'
    );

    expect(plan.answer).toEqual({ choice: 'no' });
  });

  test('answers a multiselect question with an array, as the host expects', () => {
    const plan = planFormAnswer(
      {
        title: '<consent-request type="deploy">deploy?</consent-request>',
        fields: [multiselectField('decision', GRANT_DECLINE)],
      },
      'grant'
    );

    expect(plan.answer).toEqual({ decision: ['provider-granted'] });
  });

  test('records which label carried the decision, so the caller can report what was sent', () => {
    const plan = planFormAnswer(
      {
        title: '<consent-request type="plan">approve?</consent-request>',
        fields: [stringField('decision', GRANT_DECLINE)],
      },
      'grant'
    );

    expect(plan.choices).toEqual([
      {
        key: 'decision',
        decision: 'grant',
        label: 'grant',
        offered: ['grant', 'decline'],
      },
    ]);
    // The value sent to the host is the one behind the chosen label, not the label itself.
    expect(plan.answer).toEqual({ decision: 'provider-granted' });
  });

  test('answers a boolean field with its default, and records a free-text answer', () => {
    const plan = planFormAnswer(
      {
        title: 'Anything else?',
        fields: [booleanField('confirm', true), stringField('note')],
      },
      'grant'
    );

    expect(plan.answer).toEqual({ confirm: true, note: '' });
    expect(plan.offScript).toEqual(['answered the free-text question "note"']);
  });
});

describe('the session agent', () => {
  test('creates the scenario session as the profile agent V1 drives', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; path: string; body?: string }> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          ...(init?.body ? { body: String(init.body) } : {}),
        });
        if (url.pathname.endsWith('/agent')) return new Response(null, { status: 204 });
        if (url.pathname === '/api/session') return dataResponse({ id: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost(), { agent: 'orchestrator' });

      const id = await client.createSession('v2-test');

      expect(id).toBe('ses-1');
      const created = requests.find((request) => request.path === '/api/session');
      expect(created?.body).toContain('"agent":"orchestrator"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('leaves the host default agent alone when the scenario names none', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(new URL(String(input)).pathname);
        return dataResponse({ id: 'ses-1' });
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost());

      await client.createSession('v2-test');

      expect(requests.some((path) => path.endsWith('/agent'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('execution and step SSE events', () => {
  test('records the execution started and succeeded events from the SSE stream', async () => {
    const originalFetch = globalThis.fetch;
    const routes: string[] = [];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        routes.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        if (url.includes('/event')) {
          const sse = [
            { type: 'session.created', data: { sessionID: 'ses-1' } },
            { type: 'session.execution.started', data: { sessionID: 'ses-1' } },
            {
              type: 'session.execution.succeeded',
              data: { sessionID: 'ses-1' },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/prompt')) return dataResponse({ id: 'msg-1', sessionID: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost());

      await client.prompt('ses-1', 'go');

      const execution = client.lastExecution();
      expect(execution).not.toBeNull();
      expect(execution?.status).toBe('succeeded');
      expect(routes.some((route) => route.endsWith('/wait'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('records the execution failed event with error details', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/event')) {
          const sse = [
            { type: 'session.created', data: { sessionID: 'ses-1' } },
            { type: 'session.execution.started', data: { sessionID: 'ses-1' } },
            {
              type: 'session.execution.failed',
              data: {
                sessionID: 'ses-1',
                error: { type: 'provider.auth', message: 'token expired', status: 401 },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/prompt')) return dataResponse({ id: 'msg-1', sessionID: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost());

      await expect(client.prompt('ses-1', 'go')).rejects.toThrow('session execution failed');

      const execution = client.lastExecution();
      expect(execution).not.toBeNull();
      expect(execution?.status).toBe('failed');
      expect(execution?.error?.type).toBe('provider.auth');
      expect(execution?.error?.message).toBe('token expired');
      expect(execution?.error?.status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('records step events (started, ended, failed) from the SSE stream', async () => {
    const originalFetch = globalThis.fetch;
    let eventCalled = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/event') && !eventCalled) {
          eventCalled = true;
          const sse = [
            { type: 'session.created', data: { sessionID: 'ses-1' } },
            { type: 'session.execution.started', data: { sessionID: 'ses-1' } },
            {
              type: 'session.step.started',
              data: {
                sessionID: 'ses-1',
                assistantMessageID: 'msg-1',
                agent: 'orchestrator',
                model: { providerID: 'crpt', modelID: 'deepseek-v4' },
                started: Date.now(),
              },
            },
            {
              type: 'session.step.ended',
              data: {
                sessionID: 'ses-1',
                assistantMessageID: 'msg-1',
                finish: 'tool-calls',
              },
            },
            {
              type: 'session.step.started',
              data: {
                sessionID: 'ses-1',
                assistantMessageID: 'msg-2',
                agent: 'orchestrator',
                model: { providerID: 'crpt', modelID: 'deepseek-v4' },
                started: Date.now(),
              },
            },
            {
              type: 'session.step.failed',
              data: {
                sessionID: 'ses-1',
                assistantMessageID: 'msg-2',
                error: { type: 'provider.timeout', message: 'LLM timed out' },
              },
            },
            { type: 'session.execution.succeeded', data: { sessionID: 'ses-1' } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/prompt')) return dataResponse({ id: 'msg-1', sessionID: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost());

      await client.prompt('ses-1', 'go');

      const steps = client.lastStepEvents();
      expect(steps).toHaveLength(4);
      expect(steps[0]?.status).toBe('started');
      expect(steps[0]?.assistantMessageID).toBe('msg-1');
      expect(steps[0]?.agent).toBe('orchestrator');
      expect(steps[0]?.model).toEqual({ providerID: 'crpt', modelID: 'deepseek-v4' });
      expect(steps[1]?.status).toBe('ended');
      expect(steps[1]?.finish).toBe('tool-calls');
      expect(steps[2]?.status).toBe('started');
      expect(steps[3]?.status).toBe('failed');
      expect(steps[3]?.error?.type).toBe('provider.timeout');
      expect(steps[3]?.error?.message).toBe('LLM timed out');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('clears step and execution events between prompts', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/event') && callCount === 0) {
          callCount++;
          const sse = [
            { type: 'session.created', data: { sessionID: 'ses-1' } },
            { type: 'session.execution.started', data: { sessionID: 'ses-1' } },
            {
              type: 'session.step.started',
              data: { sessionID: 'ses-1', assistantMessageID: 'msg-1', started: Date.now() },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/event') && callCount > 0) {
          callCount++;
          // Второй SSE вызов — только session.created, без execution/step событий
          const sse = [{ type: 'session.created', data: { sessionID: 'ses-1' } }]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/prompt')) return dataResponse({ id: 'msg-1', sessionID: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost());

      // Первый prompt с execution.started и step.started
      await expect(client.prompt('ses-1', 'first')).rejects.toThrow(
        'V2 SSE завершился до terminal-события'
      );
      expect(client.lastExecution()?.status).toBe('started');
      expect(client.lastStepEvents().length).toBe(1);
      expect(client.lastStepEvents()[0]?.status).toBe('started');

      // Второй prompt должен сбросить события. SSE возвращает только session.created,
      // поэтому lastExecution должен быть сброшен.
      await expect(client.prompt('ses-1', 'second')).rejects.toThrow(
        'V2 SSE завершился до terminal-события'
      );
      expect(client.lastExecution()).toBeNull();
      expect(client.lastStepEvents()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ignores execution and step events from unrelated sessions', async () => {
    const originalFetch = globalThis.fetch;
    let eventCalled = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/event') && !eventCalled) {
          eventCalled = true;
          const sse = [
            { type: 'session.created', data: { sessionID: 'ses-1' } },
            { type: 'session.execution.started', data: { sessionID: 'ses-1' } },
            { type: 'session.execution.started', data: { sessionID: 'other' } },
            { type: 'session.step.started', data: { sessionID: 'other', assistantMessageID: 'm' } },
            { type: 'session.execution.succeeded', data: { sessionID: 'ses-1' } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/prompt')) return dataResponse({ id: 'msg-1', sessionID: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost());

      await client.prompt('ses-1', 'go');

      // Должен записать execution события только для ses-1
      expect(client.lastExecution()?.status).toBe('succeeded');
      // step от other сессии не должен быть записан
      expect(client.lastStepEvents()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Сгенерированный клиент извлекает `data`, поэтому ответ хоста обёрнут. */
function dataResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeHost(): Host {
  return {
    url: 'http://127.0.0.1:1',
    workDir: process.cwd(),
    homeDir: process.cwd(),
    logs: () => '',
    stop: async () => {},
  };
}
