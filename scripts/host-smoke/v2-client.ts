import { OpenCode, type OpenCodeClient } from '@opencode/client';

import { readWorkflowSession, type Host } from './harness.ts';

export interface V2SmokeClient {
  createSession(title: string): Promise<string>;
  prompt(sessionId: string, text: string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
}

export type V2SmokeTransport = typeof fetch;

export function createV2SmokeTransport(): V2SmokeTransport {
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.headers.get('content-type')) return response;

    const body = await response.arrayBuffer();
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response(body, response);
    }

    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    return new Response(body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }) as typeof fetch;
  transport.preconnect = fetch.preconnect;
  return transport;
}

export function createV2SmokeClient(host: Host): V2SmokeClient {
  const transport = createV2SmokeTransport();
  const client = OpenCode.make({ baseUrl: host.url, fetch: transport });
  return {
    async createSession(title: string): Promise<string> {
      const session = await client.session.create({
        title,
        location: { directory: host.workDir },
      });
      return session.id;
    },
    async prompt(sessionId: string, text: string): Promise<void> {
      await client.session.prompt({ sessionID: sessionId, text });
      await client.session.wait({ sessionID: sessionId });
    },
    async removeSession(sessionId: string): Promise<void> {
      await client.session.remove({ sessionID: sessionId });
    },
  };
}

export async function runV2WorkflowCreate(
  client: V2SmokeClient,
  host: Host,
  instruction: string
): Promise<{ sessionId: string; state: unknown | null }> {
  const sessionId = await client.createSession('v2-workflow-create');
  try {
    await client.prompt(sessionId, instruction);
    return { sessionId, state: await readWorkflowSession(host, sessionId) };
  } finally {
    await client.removeSession(sessionId);
  }
}

export type V2OpenCodeClient = OpenCodeClient;
