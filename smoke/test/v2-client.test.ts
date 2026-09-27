import { describe, expect, test } from 'bun:test';

import {
  PromptTimeoutError,
  createV2SmokeClient,
  createV2SmokeTransport,
  planFormAnswer,
  promptTimeoutMs,
} from '../src/v2-client.ts';
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
      const switched = requests.find((request) => request.path.endsWith('/ses-1/agent'));
      expect(switched?.body).toContain('orchestrator');
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

describe('the prompt budget', () => {
  test('defaults to a bounded budget, not an unbounded wait', () => {
    expect(promptTimeoutMs({})).toBe(60_000);
    expect(promptTimeoutMs({ HOST_SMOKE_PROMPT_TIMEOUT_MS: '' })).toBe(60_000);
  });

  test('takes the budget the environment asks for', () => {
    expect(promptTimeoutMs({ HOST_SMOKE_PROMPT_TIMEOUT_MS: '5000' })).toBe(5_000);
  });

  test('falls back to the default rather than accepting an unusable budget', () => {
    expect(promptTimeoutMs({ HOST_SMOKE_PROMPT_TIMEOUT_MS: 'soon' })).toBe(60_000);
    expect(promptTimeoutMs({ HOST_SMOKE_PROMPT_TIMEOUT_MS: '0' })).toBe(60_000);
    expect(promptTimeoutMs({ HOST_SMOKE_PROMPT_TIMEOUT_MS: '-1' })).toBe(60_000);
  });

  test('stops waiting on a prompt that outlives it, and says what was pending', async () => {
    const originalFetch = globalThis.fetch;
    const routes: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        routes.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/form')) return dataResponse([]);
        if (url.includes('/prompt')) return dataResponse({ id: 'msg-1', sessionID: 'ses-1' });
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost(), { promptTimeoutMs: 50 });

      const failure = client.prompt('ses-1', 'Call the tool `workflow-create`.');
      await expect(failure).rejects.toThrow(PromptTimeoutError);
      await expect(failure).rejects.toThrow('session.wait не завершился за 50 мс');
      await expect(failure).rejects.toThrow('у хоста нет ожидающей формы');
      // Завис именно wait, а не enqueue.
      expect(routes.some((route) => route.endsWith('/wait'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports a form the host is still waiting on when the budget runs out', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/wait')) return new Promise<Response>(() => {});
        if (url.includes('/reply')) return new Promise<Response>(() => {});
        if (url.includes('/form'))
          return dataResponse([{ id: 'form-1', title: 'Approve?', fields: [] }]);
        return dataResponse({});
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const client = createV2SmokeClient(fakeHost(), { promptTimeoutMs: 50 });

      await expect(client.prompt('ses-1', 'go')).rejects.toThrow('хост всё ещё ожидает 1 форм');
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
    workDir: '/nowhere',
    homeDir: '/nowhere',
    logs: () => '',
    stop: async () => {},
  };
}
