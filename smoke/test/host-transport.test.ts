import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '../src/harness.ts';
import { EnvironmentUnavailableError, ensureOpencodeBinary } from '../src/harness.ts';
import {
  LiveEnvironmentUnavailableError,
  classifyBootstrapError,
  createSmokeHost,
  createTransport,
  scenarioHostOptions,
} from '../src/host/facade.ts';
import type { HostTransport } from '../src/host/transport.ts';
import type { SmokeSession } from '../src/host/types.ts';
import { canonicalScenarios } from '../src/registry.ts';
import {
  buildPromptResult,
  normalizeLegacyPart,
  normalizeSessionContent,
  normalizeWorkflowState,
  pluginObservationFrom,
  sharedToolName,
  SHELL_TOOL,
  toolCallsFromParts,
} from '../src/host/transport.ts';
import {
  assistantContentAfterLastUser,
  createSessionClientTransport,
} from '../src/host/v2-transport.ts';
import { PromptTimeoutError } from '../src/v2-client.ts';
import type { V2SmokeClient } from '../src/v2-client.ts';
import type { ScenarioDefinition } from '../src/host/types.ts';

function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    url: 'http://127.0.0.1:1',
    workDir: '/nowhere',
    homeDir: '/nowhere',
    logs: () => '',
    stop: async () => {},
    ...overrides,
  };
}

/** Route a stubbed fetch and record what the strategy asked for. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  requests: Array<{ method: string; path: string; body?: string }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body?: string }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      return handler(url.toString(), init);
    },
    { preconnect: original.preconnect }
  );
  return { requests, restore: () => (globalThis.fetch = original) };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('normalizing a host payload into the shared smoke model', () => {
  test('reads a V1 text part, a tool part and drops model reasoning', () => {
    expect(normalizeLegacyPart({ type: 'text', text: 'hello' })).toEqual({
      kind: 'text',
      text: 'hello',
    });
    expect(
      normalizeLegacyPart({
        type: 'tool',
        tool: 'workflow-list',
        state: { status: 'completed', output: '{"profilesDir":"/tmp","profiles":["smoke"]}' },
      })
    ).toEqual({
      kind: 'tool',
      tool: 'workflow-list',
      status: 'completed',
      output: '{"profilesDir":"/tmp","profiles":["smoke"]}',
    });
    expect(normalizeLegacyPart({ type: 'reasoning', text: 'thinking out loud' })).toBeUndefined();
    expect(normalizeLegacyPart({ type: 'step-start' })).toEqual({ kind: 'unknown' });
  });

  test('reads a V2 tool result from its structured content and its error', () => {
    expect(
      normalizeSessionContent({
        type: 'tool',
        name: 'workflow-list',
        state: { status: 'completed', content: [{ type: 'text', text: 'profilesDir: smoke' }] },
      })
    ).toEqual([
      {
        kind: 'tool',
        tool: 'workflow-list',
        status: 'completed',
        output: 'profilesDir: smoke',
      },
    ]);
    expect(
      normalizeSessionContent({
        type: 'tool',
        name: 'workflow-create',
        state: { status: 'error', error: { message: 'no profile' } },
      })
    ).toEqual([{ kind: 'tool', tool: 'workflow-create', status: 'failed', error: 'no profile' }]);
    expect(normalizeSessionContent({ type: 'reasoning', text: 'thinking' })).toEqual([]);
  });

  test('names the plugin tools a V2 host ran inside its own generic tool', () => {
    // The V2 host executes plugin tools through one tool of its own and reports which plugin
    // tools ran; the wrapper is a host detail, so the normalized call is the plugin call.
    const reported = normalizeSessionContent({
      type: 'tool',
      name: 'execute',
      state: {
        status: 'completed',
        input: { code: 'const result = await tools["workflow-list"]();\nreturn result;' },
        content: [{ type: 'text', text: 'profilesDir: /tmp | smoke' }],
        metadata: { toolCalls: [{ tool: 'workflow-list', status: 'completed' }] },
      },
    });

    expect(reported).toEqual([
      {
        kind: 'tool',
        tool: 'workflow-list',
        status: 'completed',
        output: 'profilesDir: /tmp | smoke',
      },
    ]);

    // A host build that states only the executed code is read for the same name.
    const fromCode = normalizeSessionContent({
      type: 'tool',
      name: 'execute',
      state: { status: 'completed', input: { code: 'await tools["workflow-list"]()' } },
    });
    expect(fromCode).toEqual([{ kind: 'tool', tool: 'workflow-list', status: 'completed' }]);

    const unrelated = normalizeSessionContent({
      type: 'tool',
      name: 'read',
      state: { status: 'completed', input: { filePath: 'src/a.ts' } },
    });
    expect(unrelated).toEqual([{ kind: 'tool', tool: 'read', status: 'completed' }]);
  });

  test('normalizes the host shell tool to one shared name, and keeps its command', () => {
    // V1 reports the same capability as `bash`, V2 as `shell`; a shared scenario asserts one
    // name, and both hosts state the command under `state.input.command`.
    expect(
      normalizeLegacyPart({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'git log --oneline -1' } },
      })
    ).toEqual({
      kind: 'tool',
      tool: SHELL_TOOL,
      status: 'completed',
      command: 'git log --oneline -1',
    });
    expect(
      normalizeSessionContent({
        type: 'tool',
        name: 'shell',
        state: {
          status: 'completed',
          input: { command: 'git log --oneline -1' },
          content: [{ type: 'text', text: 'ok' }],
        },
      })
    ).toEqual([
      {
        kind: 'tool',
        tool: SHELL_TOOL,
        status: 'completed',
        command: 'git log --oneline -1',
        output: 'ok',
      },
    ]);
    // A plugin tool is never aliased: its name is what proves the plugin ran.
    expect(normalizeLegacyPart({ type: 'tool', tool: 'workflow-list', state: {} })).toEqual({
      kind: 'tool',
      tool: 'workflow-list',
      status: 'unknown',
    });
    expect(sharedToolName('task')).toBe('task');
  });

  test('reads the plugin refusal marker the host reported for a tool call', () => {
    // A refused task mutation is a successful result carrying the plugin's own marker; the
    // sentence is what a host that drops that metadata leaves behind.
    expect(
      normalizeLegacyPart({
        type: 'tool',
        tool: 'workflow-tasks-set-status',
        state: {
          status: 'completed',
          output:
            'workflow-tasks-set-status is refused: workflow task state is controlled by [orchestrator]',
          metadata: { refused: true, tool: 'workflow-tasks-set-status', agent: 'coder' },
        },
      })
    ).toEqual({
      kind: 'tool',
      tool: 'workflow-tasks-set-status',
      status: 'completed',
      refused: true,
      output:
        'workflow-tasks-set-status is refused: workflow task state is controlled by [orchestrator]',
    });
    // A refusal without the marker stays unflagged: the scenario may match the sentence itself.
    expect(
      normalizeLegacyPart({
        type: 'tool',
        tool: 'workflow-tasks-set-status',
        state: { status: 'completed', output: 'workflow-tasks-set-status is refused: …' },
      })
    ).toEqual({
      kind: 'tool',
      tool: 'workflow-tasks-set-status',
      status: 'completed',
      output: 'workflow-tasks-set-status is refused: …',
    });
  });

  test('narrows changed files and loop runs from the durable payload', () => {
    expect(
      normalizeWorkflowState('ses-1', {
        currentStage: 'execution',
        changedFiles: ['src/smoke-1.ts', 42],
        loopRuns: {
          'run-1': {
            taskId: 'task-0',
            stage: 'verify',
            status: 'running',
            gates: { code: 'passed', review: 'pending', noisy: 7 },
          },
        },
      })
    ).toEqual({
      sessionId: 'ses-1',
      status: 'running',
      currentStage: 'execution',
      changedFiles: ['src/smoke-1.ts'],
      runs: [
        {
          taskId: 'task-0',
          stage: 'verify',
          status: 'running',
          gates: { code: 'passed', review: 'pending' },
        },
      ],
      durableMutation: 'applied',
    });
  });

  test('infers a call outcome when the host reported only its result', () => {
    expect(toolCallsFromParts([{ kind: 'tool', tool: 'bash', output: 'ok' }])).toEqual([
      { name: 'bash', status: 'completed', output: 'ok' },
    ]);
    expect(toolCallsFromParts([{ kind: 'tool', tool: 'bash', error: 'refused' }])).toEqual([
      { name: 'bash', status: 'failed', error: 'refused' },
    ]);
    expect(toolCallsFromParts([{ kind: 'tool', tool: 'bash' }])).toEqual([
      { name: 'bash', status: 'unknown' },
    ]);
  });

  test('makes plugin loading depend on a plugin tool call, never on a finished prompt', () => {
    const unrelated = pluginObservationFrom(
      [{ name: 'bash', status: 'completed', output: 'ok' }],
      'completed'
    );
    expect(unrelated.loaded).toBe(false);
    expect(unrelated.observedPluginTools).toEqual([]);

    const plugin = pluginObservationFrom(
      [{ name: 'workflow-list', status: 'completed', output: '{}' }],
      'completed'
    );
    expect(plugin.loaded).toBe(true);
    expect(plugin.observedPluginTools).toEqual(['workflow-list']);
    // The origin is the caller's claim, and this builder claims nothing on its own.
    expect(plugin.hostOperation).toBe('unknown');
    expect(plugin.result).toBe('success');

    expect(
      pluginObservationFrom([{ name: 'workflow-list', status: 'failed', error: 'no' }], 'completed')
        .result
    ).toBe('error');
    expect(pluginObservationFrom([], 'completed').result).toBe('unknown');
  });

  test('binds a turn to its operator notes and pending interaction', () => {
    const result = buildPromptResult(
      {
        status: 'timed-out',
        parts: [{ kind: 'text', text: 'partial' }],
        error: 'budget',
        pendingInteraction: true,
        notes: ['[вопрос вне сценария] refused'],
      },
      null,
      'real-host'
    );

    expect(result.turn.status).toBe('timed-out');
    expect(result.turn.pendingInteraction).toBe(true);
    expect(result.pluginEvidence.hostOperation).toBe('real-host');
    expect(result.turn.transcript).toContain('[вопрос вне сценария] refused');
    expect(result.turn.transcript).toContain('budget');
    expect(result.turn.transcript).toContain('partial');
    expect(result.workflowState).toBeNull();
  });

  test('narrows durable plugin state and reports absent state as null', () => {
    expect(normalizeWorkflowState('ses-1', null)).toBeNull();
    expect(
      normalizeWorkflowState('ses-1', {
        currentStage: 'planning',
        tasks: { implementation: [{ status: 'pending' }, {}] },
      })
    ).toEqual({
      sessionId: 'ses-1',
      status: 'running',
      currentStage: 'planning',
      tasks: { implementation: [{ status: 'pending' }, {}] },
      durableMutation: 'applied',
    });
    expect(normalizeWorkflowState('ses-1', { status: 'completed' })).toEqual({
      sessionId: 'ses-1',
      status: 'completed',
      durableMutation: 'applied',
    });
  });

  test('preserves the durable revision for diagnostic checkpoints', () => {
    expect(
      normalizeWorkflowState('ses-1', {
        revision: 9,
        currentStage: 'review',
        stageGateResults: [{ id: 'review', status: 'absent' }],
      })
    ).toMatchObject({ revision: 9, currentStage: 'review', stageGates: { review: 'absent' } });
  });

  test('refuses a stored payload that is not a workflow session', () => {
    // `null` may only mean "the store holds nothing". A payload the suite cannot vouch for
    // must not be read as a proven absence of a mutation.
    expect(() => normalizeWorkflowState('ses-1', 'not a session')).toThrow(
      'не является сессией workflow'
    );
    expect(() => normalizeWorkflowState('ses-1', 42)).toThrow('не является сессией workflow');
    expect(() => normalizeWorkflowState('ses-1', [1, 2])).toThrow('не является сессией workflow');
    expect(() => normalizeWorkflowState('ses-1', { somethingElse: true })).toThrow(
      'не содержит ни одного поля сессии workflow'
    );
  });
});

describe('the V1 transport strategy', () => {
  test('reads the turn from the stored messages, where the tool call actually is', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'host-smoke-v1-'));
    const runtime = join(stateDir, 'data', 'opencode', 'session-guard', 'runtime', 'archive');
    await mkdir(runtime, { recursive: true });
    await writeFile(
      join(runtime, 'ses-1.json'),
      JSON.stringify({ currentStage: 'planning' }),
      'utf-8'
    );

    // The session is empty before the prompt; the turn adds its own messages, and the answer to
    // a question lands in the middle of them as a user message of its own.
    let turnComplete = false;
    const listing = [
      {
        info: { role: 'assistant', time: { created: 4 } },
        parts: [
          { type: 'step-start' },
          {
            type: 'tool',
            tool: 'workflow-list',
            state: {
              status: 'completed',
              input: {},
              output: '{"profilesDir":"/tmp","profiles":["smoke"]}',
            },
          },
          { type: 'step-finish' },
        ],
      },
      { info: { role: 'user', time: { created: 5 } }, parts: [{ type: 'text', text: 'grant' }] },
      {
        info: { role: 'assistant', time: { created: 6 } },
        parts: [{ type: 'text', text: 'here is the output' }],
      },
    ];
    const stub = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'POST') return json({ id: 'ses-1' });
      if (url.endsWith('/session/ses-1/message') && method === 'POST') {
        // The legacy endpoint answers with the last message of the turn only, and the tool
        // call of the same turn lives in an earlier assistant message.
        turnComplete = true;
        return json({ parts: [{ type: 'text', text: 'here is the output' }] });
      }
      if (url.endsWith('/session/ses-1/message') && method === 'GET') {
        return json(turnComplete ? listing : []);
      }
      if (url.endsWith('/session/ses-1') && method === 'DELETE') {
        return new Response('', { status: 204 });
      }
      return json([]);
    });

    try {
      const transport = createTransport(fakeHost({ homeDir: stateDir }), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
        agent: 'orchestrator',
      });
      const session = await transport.createSession('create');
      expect(session).toEqual({ id: 'ses-1', hostKind: 'v1' });

      const result = await transport.prompt(session, {
        text: 'Call the tool `workflow-list`.',
        agent: 'orchestrator',
      });

      expect(result.turn.status).toBe('completed');
      expect(result.pluginEvidence.loaded).toBe(true);
      expect(result.pluginEvidence.observedPluginTools).toEqual(['workflow-list']);
      expect(result.turn.toolCalls).toEqual([
        {
          name: 'workflow-list',
          status: 'completed',
          output: '{"profilesDir":"/tmp","profiles":["smoke"]}',
        },
      ]);
      // The final text of the same turn is kept even though an answer added a user message.
      expect(result.turn.transcript).toContain('here is the output');
      expect(result.turn.transcript).toContain('profilesDir');
      expect(result.workflowState).toEqual({
        sessionId: 'ses-1',
        status: 'running',
        currentStage: 'planning',
        durableMutation: 'applied',
      });

      const message = stub.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/message')
      );
      expect(message?.body).toContain('"agent":"orchestrator"');
      expect(message?.body).toContain('"model":{"providerID":"crpt","modelID":"model"}');

      await transport.removeSession(session);
      expect(
        stub.requests.some(
          (request) => request.method === 'DELETE' && request.path.endsWith('/ses-1')
        )
      ).toBe(true);
    } finally {
      stub.restore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('keeps the tool calls of a turn whose question was answered mid-turn', async () => {
    // The answer is stored as a user message (#1), so a role-based boundary would cut away the
    // very tool calls this turn produced. The measured boundary keeps them.
    let turnComplete = false;
    const listing = [
      {
        info: { role: 'assistant', time: { created: 4 } },
        parts: [
          { type: 'tool', tool: 'workflow-consent', state: { status: 'completed', input: {} } },
        ],
      },
      {
        info: { role: 'assistant', time: { created: 5 } },
        parts: [{ type: 'tool', tool: 'question', state: { status: 'completed', input: {} } }],
      },
      { info: { role: 'user', time: { created: 6 } }, parts: [{ type: 'text', text: 'grant' }] },
      {
        info: { role: 'assistant', time: { created: 7 } },
        parts: [{ type: 'text', text: 'consent recorded' }],
      },
    ];
    const stub = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'POST') return json({ id: 'ses-1' });
      if (url.endsWith('/session/ses-1/message') && method === 'POST') {
        turnComplete = true;
        return json({ parts: [{ type: 'text', text: 'consent recorded' }] });
      }
      if (url.endsWith('/session/ses-1/message') && method === 'GET') {
        return json(turnComplete ? listing : []);
      }
      return json([]);
    });

    try {
      const transport = createTransport(fakeHost(), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
      });
      const session = await transport.createSession('plan-consent');

      const result = await transport.prompt(session, { text: 'ask for consent' });

      expect(result.turn.toolCalls.map((call) => call.name)).toEqual([
        'workflow-consent',
        'question',
      ]);
      expect(result.turn.transcript).toContain('consent recorded');
    } finally {
      stub.restore();
    }
  });

  test('falls back to the prompt response when the stored messages cannot be read', async () => {
    const stub = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'POST') return json({ id: 'ses-1' });
      if (url.endsWith('/session/ses-1/message') && method === 'POST') {
        return json({
          parts: [
            {
              type: 'tool',
              tool: 'workflow-list',
              state: { status: 'completed', output: 'profilesDir: smoke' },
            },
          ],
        });
      }
      if (url.endsWith('/session/ses-1/message') && method === 'GET') {
        return new Response('boom', { status: 500 });
      }
      return json([]);
    });

    try {
      const transport = createTransport(fakeHost(), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
      });
      const session = await transport.createSession('create');

      const result = await transport.prompt(session, { text: 'list profiles' });

      expect(result.pluginEvidence.loaded).toBe(true);
      expect(result.turn.toolCalls).toEqual([
        { name: 'workflow-list', status: 'completed', output: 'profilesDir: smoke' },
      ]);
    } finally {
      stub.restore();
    }
  });

  test('reports a stored payload that is not a session instead of calling it no state', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'host-smoke-v1-damaged-'));
    const runtime = join(stateDir, 'data', 'opencode', 'session-guard', 'runtime');
    await mkdir(runtime, { recursive: true });
    // Valid JSON, but not a workflow session: the store holds something the suite cannot
    // vouch for, so reading it must fail rather than report an absent session.
    await writeFile(join(runtime, 'ses-1.json'), JSON.stringify('not a session'), 'utf-8');

    const stub = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'POST') return json({ id: 'ses-1' });
      return json({ parts: [] });
    });

    try {
      const transport = createTransport(fakeHost({ homeDir: stateDir }), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
      });
      const session = await transport.createSession('create');

      await expect(transport.readWorkflowState(session)).rejects.toThrow(
        'не является сессией workflow'
      );
    } finally {
      stub.restore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('reports a missing session id instead of returning a half-built session', async () => {
    const stub = stubFetch(() => json({}));
    try {
      const transport = createTransport(fakeHost(), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
      });
      await expect(transport.createSession('create')).rejects.toThrow(
        'хост V1 не вернул идентификатор сессии'
      );
    } finally {
      stub.restore();
    }
  });
});

describe('the V2 transport strategy', () => {
  function fakeClient(overrides: Partial<V2SmokeClient> = {}): V2SmokeClient {
    return {
      createSession: async () => 'ses-2',
      prompt: async () => {},
      removeSession: async () => {},
      listMessages: async () => [],
      switchAgent: async () => {},
      answeredForms: () => [],
      offScript: () => [],
      lastExecution: () => null,
      lastStepEvents: () => [],
      ...overrides,
    };
  }

  test('normalizes assistant messages of the last instruction into tool calls', async () => {
    const client = fakeClient({
      listMessages: async () => [
        {
          type: 'user',
          time: { created: 1 },
          content: [{ type: 'text', text: 'old instruction' }],
        },
        { type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: 'old reply' }] },
        { type: 'user', time: { created: 3 }, content: [{ type: 'text', text: 'new' }] },
        {
          type: 'assistant',
          time: { created: 4 },
          content: [
            { type: 'text', text: 'called the tool' },
            {
              type: 'tool',
              name: 'workflow-list',
              state: {
                status: 'completed',
                content: [{ type: 'text', text: 'profilesDir: smoke' }],
              },
            },
          ],
        },
      ],
    });

    const transport = createSessionClientTransport(
      fakeHost(),
      { agent: 'orchestrator' },
      () => client
    );
    const session = await transport.createSession('create');
    expect(session).toEqual({ id: 'ses-2', hostKind: 'v2' });

    const result = await transport.prompt(session, {
      text: 'list profiles',
      agent: 'orchestrator',
    });

    expect(result.turn.transcript).toContain('called the tool');
    expect(result.turn.transcript).not.toContain('old reply');
    expect(result.pluginEvidence.invokedTools).toEqual([
      { name: 'workflow-list', status: 'completed', output: 'profilesDir: smoke' },
    ]);
  });

  test('turns a prompt that outlived its budget into a timed-out turn, not an exception', async () => {
    const client = fakeClient({
      prompt: async () => {
        throw new PromptTimeoutError('session.wait', 50, 'хост всё ещё ожидает 1 форм', 1);
      },
    });
    const transport = createSessionClientTransport(fakeHost(), {}, () => client);
    const session = await transport.createSession('create');

    const result = await transport.prompt(session, { text: 'create' });

    expect(result.turn.status).toBe('timed-out');
    expect(result.turn.pendingInteraction).toBe(true);
    expect(result.turn.transcript).toContain('хост всё ещё ожидает 1 форм');
  });

  test('switches the session agent for a step that names another one', async () => {
    const switched: string[] = [];
    const client: V2SmokeClient = {
      ...fakeClient({ offScript: () => ['answered the free-text question "note"'] }),
      switchAgent: async (_id: string, agent: string) => {
        switched.push(agent);
      },
    };
    const transport = createSessionClientTransport(
      fakeHost(),
      { agent: 'orchestrator' },
      () => client
    );

    const result = await transport.prompt(
      { id: 'ses-2', hostKind: 'v2' },
      { text: 'go', agent: 'reviewer' }
    );

    expect(result.turn.transcript).toContain('answered the free-text question "note"');
    // V2 keeps the agent on the session, so a worker step is switched to before its prompt.
    expect(switched).toEqual(['reviewer']);
    expect(result.turn.transcript).toContain('агент сессии переключён на «reviewer»');
  });

  test('orders messages by host timestamps when picking the last turn', () => {
    const content = assistantContentAfterLastUser([
      { type: 'assistant', time: { created: 9 }, content: [{ type: 'text', text: 'new' }] },
      { type: 'user', time: { created: 8 }, content: [] },
      { type: 'assistant', time: { created: 5 }, content: [{ type: 'text', text: 'old' }] },
      { type: 'user', time: { created: 4 }, content: [] },
    ]);

    expect(content).toEqual([{ type: 'text', text: 'new' }]);
  });
});

describe('the host operation marker', () => {
  test('is stated by the caller instead of being inherited from the builder', () => {
    // The builder itself makes no claim: anything that cannot point at a started host says so.
    const synthesized = buildPromptResult({ status: 'completed', parts: [] }, null, 'unknown');
    expect(synthesized.pluginEvidence.hostOperation).toBe('unknown');

    const fromTransport = buildPromptResult({ status: 'completed', parts: [] }, null, 'real-host');
    expect(fromTransport.pluginEvidence.hostOperation).toBe('real-host');
  });

  test('is confirmed for both transport strategies through the facade', async () => {
    const calls: string[] = [];
    const transport = (hostKind: 'v1' | 'v2'): HostTransport => ({
      createSession: async () => ({ id: 'ses-1', hostKind }),
      prompt: async () => buildPromptResult({ status: 'completed', parts: [] }, null, 'real-host'),
      readWorkflowState: async () => null,
      removeSession: async () => {},
    });
    const runtime = {
      workDir: '/nowhere',
      homeDir: '/tmp/smoke-home',
      model: 'crpt/model',
      logs: () => '',
      stop: async () => {},
    };

    for (const kind of ['v1', 'v2'] as const) {
      const host = createSmokeHost(kind, transport(kind), runtime);
      const session = await host.createSession('create');
      const result = await host.runPrompt(session, { text: 'go' });
      expect(result.pluginEvidence.hostOperation).toBe('real-host');
      calls.push(kind);
    }
    expect(calls).toEqual(['v1', 'v2']);
  });

  test('refuses a transport that does not confirm host operation', async () => {
    const transport: HostTransport = {
      createSession: async () => ({ id: 'ses-1', hostKind: 'v1' }),
      // A strategy that cannot claim a live host must not be able to hand the scenario evidence
      // the scenario would trust.
      prompt: async () => buildPromptResult({ status: 'completed', parts: [] }, null, 'unknown'),
      readWorkflowState: async () => null,
      removeSession: async () => {},
    };
    const host = createSmokeHost('v1', transport, {
      workDir: '/nowhere',
      homeDir: '/tmp/smoke-home',
      model: 'crpt/model',
      logs: () => '',
      stop: async () => {},
    });
    const session = await host.createSession('create');

    await expect(host.runPrompt(session, { text: 'go' })).rejects.toThrow(
      'did not confirm host operation'
    );
  });

  test('is checked by the plugin-loads step, not trusted blindly', () => {
    const step = canonicalScenarios.find((scenario) => scenario.id === 'plugin-loads')!.steps![0]!;
    const toolCall = {
      name: 'workflow-list',
      status: 'completed' as const,
      output: '{"profilesDir":"/tmp","profiles":["smoke"]}',
    };
    const evidence = {
      loaded: true,
      observedPluginTools: ['workflow-list'],
      invokedTools: [toolCall],
      result: 'success' as const,
    };

    expect(
      step.expect({
        turn: { status: 'completed', transcript: '', parts: [], toolCalls: [toolCall] },
        workflowState: null,
        pluginEvidence: { ...evidence, hostOperation: 'real-host' },
      })
    ).toBe(true);
    expect(
      step.expect({
        turn: { status: 'completed', transcript: '', parts: [], toolCalls: [toolCall] },
        workflowState: null,
        pluginEvidence: { ...evidence, hostOperation: 'unknown' },
      })
    ).toContain('не от живого хоста');
  });
});

describe('the interaction the facade answered', () => {
  test('reports a V1 question and sends the decision the step asked for', async () => {
    const stub = stubFetch(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'POST') return json({ id: 'ses-1' });
      if (url.endsWith('/event'))
        return new Response(
          [
            { type: 'session.created', properties: { info: { id: 'child', parentID: 'ses-1' } } },
            {
              type: 'session.created',
              properties: { info: { id: 'grandchild', parentID: 'child' } },
            },
            {
              type: 'session.created',
              properties: { info: { id: 'independent', parentID: 'other' } },
            },
            ...['ses-1', 'child', 'grandchild', 'independent'].map((sessionID, index) => ({
              type: 'question.asked',
              properties: {
                id: `q-${index + 1}`,
                sessionID,
                questions: [
                  {
                    question: '<consent-request type="plan">approve?</consent-request>',
                    options: [{ label: 'grant' }, { label: 'decline' }],
                  },
                ],
              },
            })),
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      if (url.includes('/question/q-1/reply') && method === 'POST') return json({});
      if (url.endsWith('/session/ses-1/message') && method === 'POST') {
        // Give the operator loop time to answer while the turn is still running.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return json({ parts: [] });
      }
      return json([]);
    });

    try {
      const transport = createTransport(fakeHost(), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
        agent: 'orchestrator',
      });
      const session = await transport.createSession('plan-consent');

      const result = await transport.prompt(session, {
        text: 'ask for consent',
        decision: 'decline',
      });

      expect(result.interactions).toHaveLength(3);
      expect(result.interactions?.map((interaction) => interaction.id)).toEqual([
        'q-1',
        'q-2',
        'q-3',
      ]);
      const reply = stub.requests.find((request) => request.path.includes('/question/q-1/reply'));
      expect(reply?.body).toContain('decline');
      expect(
        stub.requests.some((request) => request.method === 'GET' && request.path.endsWith('/event'))
      ).toBe(true);
      expect(
        stub.requests.some(
          (request) => request.method === 'GET' && request.path.endsWith('/question')
        )
      ).toBe(false);
    } finally {
      stub.restore();
    }
  });

  test('reports a V2 form and passes the decision to the client', async () => {
    const prompts: Array<{ text: string; decision?: string }> = [];
    const client: V2SmokeClient = {
      createSession: async () => 'ses-2',
      prompt: async (_id: string, text: string, decision?: string) => {
        prompts.push({ text, decision });
      },
      removeSession: async () => {},
      listMessages: async () => [],
      switchAgent: async () => {},
      answeredForms: () => [
        {
          id: 'form-1',
          consent: true,
          decision: 'grant' as const,
          label: 'grant',
          offered: ['grant', 'decline'],
        },
      ],
      offScript: () => [],
      lastExecution: () => null,
      lastStepEvents: () => [],
    };
    const transport = createSessionClientTransport(fakeHost(), {}, () => client);
    const session = await transport.createSession('plan-consent');

    const result = await transport.prompt(session, { text: 'ask for consent', decision: 'grant' });

    expect(prompts).toEqual([{ text: 'ask for consent', decision: 'grant' }]);
    expect(result.interactions).toEqual([
      {
        kind: 'form',
        id: 'form-1',
        isConsent: true,
        decision: 'grant',
        label: 'grant',
        offered: ['grant', 'decline'],
      },
    ]);
  });

  test('reports no interaction when the host raised none', async () => {
    const stub = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'POST') return json({ id: 'ses-1' });
      if (url.endsWith('/session/ses-1/message') && method === 'POST') return json({ parts: [] });
      return json([]);
    });

    try {
      const transport = createTransport(fakeHost(), {
        kind: 'v1',
        model: 'crpt/model',
        profile: 'smoke',
      });
      const session = await transport.createSession('create');

      const result = await transport.prompt(session, { text: 'no question here' });

      expect(result.interactions).toEqual([]);
    } finally {
      stub.restore();
    }
  });
});

describe('bootstrap failures', () => {
  test('keeps a missing binary and an unresolved model as not-run conditions', () => {
    const missing = classifyBootstrapError(
      'v2',
      new EnvironmentUnavailableError('[ERROR] бинарник opencode v2 не найден')
    );

    expect(missing).toBeInstanceOf(LiveEnvironmentUnavailableError);
    expect((missing as LiveEnvironmentUnavailableError).hostKind).toBe('v2');
  });

  test('leaves a broken harness or plugin fatal instead of hiding it as not-run', () => {
    const brokenProfile = new Error('[ERROR] профиль smoke не найден');
    const failedBuild = new Error('[ERROR] mise run build завершился со статусом 1');

    expect(classifyBootstrapError('v1', brokenProfile)).toBe(brokenProfile);
    expect(classifyBootstrapError('v1', failedBuild)).not.toBeInstanceOf(
      LiveEnvironmentUnavailableError
    );
  });

  test('marks the environment unavailable when the host binary is absent', () => {
    expect(() =>
      ensureOpencodeBinary('v1', { HOST_SMOKE_V1_BINARY: '/nonexistent/opencode' })
    ).toThrow(EnvironmentUnavailableError);
  });
});

describe('the facade session ownership', () => {
  function recordingTransport(calls: string[]): HostTransport {
    return {
      createSession: async (title) => {
        calls.push(`create:${title}`);
        return { id: 'ses-1', hostKind: 'v1' };
      },
      prompt: async (session) => {
        calls.push(`prompt:${session.id}`);
        return {
          turn: { status: 'completed', transcript: '', parts: [], toolCalls: [] },
          workflowState: null,
          pluginEvidence: {
            loaded: false,
            observedPluginTools: [],
            invokedTools: [],
            hostOperation: 'real-host',
            result: 'unknown',
          },
        };
      },
      readWorkflowState: async (session) => {
        calls.push(`read:${session.id}`);
        return null;
      },
      removeSession: async (session) => {
        calls.push(`remove:${session.id}`);
      },
    };
  }

  const runtime = {
    workDir: '/nowhere',
    homeDir: '/tmp/smoke-home',
    model: 'crpt/model',
    logs: () => '',
    stop: async () => {},
  };

  test('refuses to drive a session that belongs to another host kind', async () => {
    const calls: string[] = [];
    const host = createSmokeHost('v2', recordingTransport(calls), runtime);
    const foreign: SmokeSession = { id: 'ses-v1', hostKind: 'v1' };

    await expect(host.runPrompt(foreign, { text: 'go' })).rejects.toThrow(
      'хост v2 получил сессию хоста v1'
    );
    await expect(host.readWorkflowState(foreign)).rejects.toThrow('сессию обслуживает только');
    await expect(host.closeSession(foreign)).rejects.toThrow('хост v2 получил сессию хоста v1');
    // Nothing reached the transport of the other host.
    expect(calls).toEqual([]);
  });

  test('drives its own session through its own transport', async () => {
    const calls: string[] = [];
    const host = createSmokeHost('v1', recordingTransport(calls), runtime);

    const session = await host.createSession('create');
    await host.runPrompt(session, { text: 'go' });
    await host.readWorkflowState(session);
    await host.closeSession(session);

    expect(session).toEqual({ id: 'ses-1', hostKind: 'v1' });
    expect(calls).toEqual(['create:create', 'prompt:ses-1', 'read:ses-1', 'remove:ses-1']);
  });
});

describe('canonical scenario inputs for both host kinds', () => {
  const definition: ScenarioDefinition = {
    id: 'create',
    title: 'Create',
    profile: 'cicd',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    files: { 'scenario.md': 'own file' },
    git: false,
    agent: 'orchestrator',
    migrationState: 'migrated',
    steps: [],
  };

  test('hands both host kinds the same profile, env, files and git decision', () => {
    const common = { 'plan.md': 'plan' };
    const v1 = scenarioHostOptions(definition, 'v1', 'crpt/model', common);
    const v2 = scenarioHostOptions(definition, 'v2', 'crpt/model', common);

    expect(v1).toEqual({
      kind: 'v1',
      model: 'crpt/model',
      profile: 'cicd',
      env: { HARNESS_AUTO_APPROVE: 'true' },
      files: { 'plan.md': 'plan', 'scenario.md': 'own file' },
      git: false,
      agent: 'orchestrator',
    });
    expect({ ...v2, kind: 'v1' }).toEqual(v1);
  });

  test('defaults to the smoke profile, the common files and a git project', () => {
    const bare: ScenarioDefinition = { id: 'x', title: 'x', migrationState: 'pending' };

    expect(scenarioHostOptions(bare, 'v1', 'crpt/model', { 'plan.md': 'plan' })).toEqual({
      kind: 'v1',
      model: 'crpt/model',
      profile: 'smoke',
      env: {},
      files: { 'plan.md': 'plan' },
      git: true,
    });
  });

  test('selects the transport strategy from the host kind and nothing else', async () => {
    const stub = stubFetch((url) => {
      // The generated V2 client unwraps `data`; the V1 API answers the body itself.
      if (url.endsWith('/api/session')) return json({ data: { id: 'ses-1' } });
      if (url.endsWith('/session')) return json({ id: 'ses-1' });
      return json({ data: {} });
    });
    try {
      const v1 = createTransport(fakeHost(), { kind: 'v1', model: 'crpt/model', profile: 'smoke' });
      await v1.createSession('one');
      const v2 = createTransport(fakeHost(), { kind: 'v2', model: 'crpt/model', profile: 'smoke' });
      await v2.createSession('two');

      const paths = stub.requests.map((request) => request.path);
      expect(paths.some((path) => path === '/session')).toBe(true);
      expect(paths.some((path) => path === '/api/session')).toBe(true);
    } finally {
      stub.restore();
    }
  });
});
