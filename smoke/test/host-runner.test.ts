import { describe, expect, test } from 'bun:test';

import type { SmokeHost } from '../src/host/facade.ts';
import { SHELL_TOOL, pluginObservationFrom } from '../src/host/transport.ts';
import { canonicalScenarios } from '../src/registry.ts';
import type {
  HostKind,
  MigratedScenarioDefinition,
  PromptInput,
  PromptResult,
  ScenarioStep,
  SmokeWorkflowState,
} from '../src/host/types.ts';
import { runScenario } from '../src/runner.ts';

const BLOCKED_REASONS = [
  'adapter_contract_mismatch',
  'required_host_capability_unavailable',
  'indeterminate_mutation',
];

function turn(
  overrides: Partial<PromptResult['turn']> = {},
  state: SmokeWorkflowState | null = null
): PromptResult {
  const toolCalls = overrides.toolCalls ?? [];
  return {
    turn: {
      status: 'completed',
      transcript: 'host said something',
      parts: [],
      toolCalls,
      ...overrides,
    },
    workflowState: state,
    pluginEvidence: pluginObservationFrom(toolCalls, overrides.status ?? 'completed'),
  };
}

function makeHost(
  replies: Array<PromptResult | Error>,
  options: { kind?: HostKind; state?: SmokeWorkflowState | null; stateError?: boolean } = {}
): {
  host: SmokeHost;
  calls: { created: string[]; prompts: PromptInput[]; closed: string[] };
} {
  const kind = options.kind ?? 'v1';
  const calls = { created: [] as string[], prompts: [] as PromptInput[], closed: [] as string[] };
  let index = 0;
  return {
    calls,
    host: {
      kind,
      async createSession(title) {
        calls.created.push(title);
        return { id: 'ses-1', hostKind: kind };
      },
      async runPrompt(_session, input) {
        calls.prompts.push(input);
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        if (reply === undefined) throw new Error('[ERROR] the test provided no reply');
        if (reply instanceof Error) throw reply;
        return reply;
      },
      async readWorkflowState() {
        if (options.stateError === true) throw new Error('[ERROR] damaged state file');
        return options.state ?? null;
      },
      async closeSession(session) {
        calls.closed.push(session.id);
      },
    },
  };
}

function definition(
  steps: ScenarioStep[],
  overrides: Partial<MigratedScenarioDefinition> = {}
): MigratedScenarioDefinition {
  return {
    id: 'create',
    title: 'Create workflow',
    migrationState: 'migrated',
    agent: 'orchestrator',
    steps,
    ...overrides,
  };
}

const readOnlyStep = (expect: ScenarioStep['expect']): ScenarioStep => ({
  instruction: 'Call the tool `workflow-list`.',
  mutation: 'read-only',
  retry: 'same-session',
  expect,
});

const mutatingStep = (
  retry: ScenarioStep['retry'],
  expect: ScenarioStep['expect']
): ScenarioStep => ({
  instruction: 'Call the tool `workflow-create`.',
  mutation: 'mutating',
  retry,
  expect,
});

const planning: SmokeWorkflowState = {
  sessionId: 'ses-1',
  status: 'running',
  currentStage: 'planning',
  durableMutation: 'applied',
};

describe('the common scenario runner', () => {
  test('passes only when every step met its expectation, and closes the session', async () => {
    const first = turn({
      toolCalls: [{ name: 'workflow-list', status: 'completed', output: '{}' }],
    });
    const second = turn(
      { toolCalls: [{ name: 'workflow-list', status: 'completed', output: '{}' }] },
      planning
    );
    const { host, calls } = makeHost([first, second]);
    const seen: Array<PromptResult['pluginEvidence']> = [];

    const result = await runScenario(
      host,
      definition([
        readOnlyStep((reply) => {
          seen.push(reply.pluginEvidence);
          return reply.pluginEvidence.loaded ? true : 'плагин не загружен';
        }),
        mutatingStep('none', (reply) => reply.workflowState?.currentStage === 'planning' || 'нет'),
      ])
    );

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(2);
    expect(result.hostKind).toBe('v1');
    expect(result.evidence).toContain('stage=planning');
    expect(result.evidence).toContain('workflow-list');
    expect(seen[0]?.loaded).toBe(true);
    expect(calls.created).toEqual(['create']);
    expect(calls.closed).toEqual(['ses-1']);
    expect(calls.prompts[0]?.agent).toBe('orchestrator');
  });

  test('repeats a read-only step in the same session until it satisfies its expectation', async () => {
    const { host, calls } = makeHost([turn(), turn({}, planning)]);

    const result = await runScenario(
      host,
      definition([readOnlyStep((reply) => reply.workflowState !== null || 'нет состояния')]),
      { attempts: 3 }
    );

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(2);
    expect(calls.prompts).toHaveLength(2);
  });

  test('stops after the declared attempts and fails, never blocking a read-only step', async () => {
    const { host, calls } = makeHost([turn()]);

    const result = await runScenario(
      host,
      definition([readOnlyStep(() => 'ожидание не выполнено')]),
      {
        attempts: 3,
      }
    );

    expect(result.status).toBe('fail');
    expect(result.attempts).toBe(3);
    expect(calls.prompts).toHaveLength(3);
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.blockedReason).toBeUndefined();
    expect(result.evidence).toContain('ожидание не выполнено');
  });

  test('blocks an unprovable mutating outcome instead of repeating the mutation', async () => {
    const { host, calls } = makeHost([turn({ status: 'timed-out' })]);

    const result = await runScenario(
      host,
      definition([mutatingStep('none', () => 'сессия workflow не сохранена')])
    );

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    // The mutation is sent once: nothing repeats an instruction whose first run may have landed.
    expect(calls.prompts).toHaveLength(1);
    expect(calls.closed).toEqual(['ses-1']);
    expect(result.evidence).toContain('hostKind=v1');
    expect(result.evidence).toContain('mutation=mutating');
    expect(result.evidence).toContain('durableMutation=none');
    expect(result.evidence).toContain('ход хоста не завершился за бюджет промпта');
    expect(BLOCKED_REASONS).toContain(result.blockedReason);
  });

  test('blocks when the durable store itself cannot be read for a mutating step', async () => {
    const { host } = makeHost([turn()], { stateError: true });

    const result = await runScenario(host, definition([mutatingStep('none', () => 'нет')]));

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(result.evidence).toContain('durableMutation=unknown');
    // The reason the store could not be vouched for belongs in the evidence.
    expect(result.evidence).toContain('damaged state file');
  });

  test('never repeats a mutating instruction even when the step asks for same-session', async () => {
    const { host, calls } = makeHost([turn()]);

    const result = await runScenario(
      host,
      definition([mutatingStep('same-session', () => 'ожидание не выполнено')]),
      { attempts: 5 }
    );

    expect(calls.prompts).toHaveLength(1);
    expect(result.status).toBe('fail');
    expect(result.attempts).toBe(1);
  });

  test('fails a completed mutating step whose outcome is provably absent', async () => {
    const { host } = makeHost([turn()]);

    const result = await runScenario(
      host,
      definition([mutatingStep('none', () => 'нет состояния')])
    );

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('durableMutation=none');
  });

  test('blocks a mutating step whose turn failed while the store holds something', async () => {
    // A turn that answered with an error may have died in the middle of its mutation, and
    // the state that exists cannot be attributed to this step.
    const other: SmokeWorkflowState = {
      sessionId: 'ses-1',
      status: 'running',
      currentStage: 'planning',
      durableMutation: 'applied',
    };
    const { host } = makeHost([turn({ status: 'failed' })], { state: other });

    const result = await runScenario(
      host,
      definition([mutatingStep('none', () => 'стадия — planning, ожидалась execution')])
    );

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(result.evidence).toContain('свежее чтение состояния ожидание не подтвердило');
  });

  test('still fails a failed turn whose store is empty, because nothing landed', async () => {
    const { host } = makeHost([turn({ status: 'failed' })]);

    const result = await runScenario(
      host,
      definition([mutatingStep('none', () => 'нет состояния')])
    );

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('durableMutation=none');
  });

  test('fails on a prompt exception for a read-only step and still closes the session', async () => {
    const { host, calls } = makeHost([new Error('[ERROR] host went away')]);

    const result = await runScenario(host, definition([readOnlyStep(() => true)]));

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('промпт шага не выполнился');
    expect(result.evidence).toContain('host went away');
    expect(calls.closed).toEqual(['ses-1']);
  });

  test('blocks a mutating step whose prompt threw and whose store cannot be read', async () => {
    const { host, calls } = makeHost([new Error('[ERROR] socket closed')], { stateError: true });

    const result = await runScenario(host, definition([mutatingStep('none', () => 'нет')]));

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(calls.prompts).toHaveLength(1);
    expect(result.evidence).toContain('socket closed');
    expect(result.evidence).toContain('durableMutation=unknown');
  });

  test('blocks a mutating step whose prompt threw with nothing provable in the store', async () => {
    // Nothing durable exists yet, but a request that died may still be in flight, so the
    // absence of the mutation is not proven and the step is not called a failure.
    const { host } = makeHost([new Error('[ERROR] connection reset')]);

    const result = await runScenario(host, definition([mutatingStep('none', () => 'нет')]));

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(result.evidence).toContain('connection reset');
    expect(result.evidence).toContain('durableMutation=none');
  });

  test('blocks a mutating step whose prompt threw while the store holds something else', async () => {
    const other: SmokeWorkflowState = {
      sessionId: 'ses-1',
      status: 'running',
      currentStage: 'planning',
      durableMutation: 'applied',
    };
    const { host } = makeHost([new Error('[ERROR] EOF')], { state: other });

    const result = await runScenario(
      host,
      definition([mutatingStep('none', () => 'стадия — planning, ожидалась execution')])
    );

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(result.evidence).toContain('durableMutation=applied');
    expect(result.evidence).toContain('свежее чтение состояния ожидание не подтвердило');
  });

  test('passes a mutating step whose prompt threw but whose outcome the store proves', async () => {
    const { host, calls } = makeHost([new Error('[ERROR] response lost')], { state: planning });

    const result = await runScenario(
      host,
      definition([
        mutatingStep('none', (reply) => reply.workflowState?.currentStage === 'planning' || 'нет'),
      ])
    );

    expect(result.status).toBe('pass');
    expect(calls.prompts).toHaveLength(1);
    expect(result.evidence).toContain('исход подтверждён сохранённым состоянием');
    expect(result.evidence).toContain('stage=planning');
  });

  test('passes a timed-out mutating step whose outcome the fresh state proves', async () => {
    const { host, calls } = makeHost([turn({ status: 'timed-out' })], { state: planning });

    const result = await runScenario(
      host,
      definition([
        mutatingStep('none', (reply) => reply.workflowState?.currentStage === 'planning' || 'нет'),
      ])
    );

    expect(result.status).toBe('pass');
    expect(calls.prompts).toHaveLength(1);
    expect(result.evidence).toContain(
      'ход хоста не завершился за бюджет промпта, исход подтверждён'
    );
  });

  test('fails without a session to close when the host cannot create one', async () => {
    const host: SmokeHost = {
      kind: 'v2',
      createSession: async () => {
        throw new Error('[ERROR] no session');
      },
      runPrompt: async () => turn(),
      readWorkflowState: async () => null,
      closeSession: async () => {
        throw new Error('[ERROR] closeSession must not be called without a session');
      },
    };

    const result = await runScenario(host, definition([readOnlyStep(() => true)]));

    expect(result.status).toBe('fail');
    expect(result.hostKind).toBe('v2');
    expect(result.evidence).toContain('no session');
  });

  test('records the attempts and duration of a failing run', async () => {
    const { host } = makeHost([turn({ status: 'failed' })]);

    const result = await runScenario(host, definition([readOnlyStep(() => 'нет')]));

    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.title).toBe('Create workflow');
  });

  test('names a live-model failure instead of leaving it to the transcript', async () => {
    // Nothing completed: the instruction never produced a plugin action, so this run does not
    // prove anything about the host, and the evidence must say which side failed.
    const { host } = makeHost([
      turn({ toolCalls: [{ name: 'bash', status: 'completed', output: 'ok' }] }),
    ]);

    const result = await runScenario(
      host,
      definition([readOnlyStep(() => 'workflow-list не вызван')])
    );

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.failureKind).toBe('model');
    expect(result.evidence).toContain('инструкцию не выполнила модель');
    expect(result.evidence).toContain('tools=[bash:completed]');
  });

  test('names observable host behaviour when the plugin ran and the expectation still failed', async () => {
    const { host } = makeHost([
      turn({
        toolCalls: [{ name: 'workflow-list', status: 'completed', output: 'broken output' }],
      }),
    ]);

    const result = await runScenario(
      host,
      definition([readOnlyStep(() => 'workflow-list не сообщил профили')])
    );

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.failureKind).toBe('host');
    expect(result.evidence).toContain('наблюдаемое поведение host/plugin');
    expect(result.evidence).toContain('tools=[workflow-list:completed]');
  });

  test('names an indefinite failure when a plugin tool was invoked but nothing completed', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [{ name: 'workflow-create', status: 'failed', error: 'no such tool' }] }),
    ]);

    const result = await runScenario(
      host,
      definition([readOnlyStep(() => 'инструмент не выполнился')])
    );

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.failureKind).toBe('unknown');
    expect(result.evidence).toContain('класс отказа: не определено');
    expect(result.evidence).toContain('tools=[workflow-create:failed]');
  });

  test('keeps a blocked verdict free of a failure class', async () => {
    const { host } = makeHost([turn({ status: 'timed-out' })]);

    const result = await runScenario(
      host,
      definition([mutatingStep('none', () => 'сессия не сохранена')])
    );

    expect(result.status).toBe('blocked');
    expect('failureKind' in result).toBe(false);
  });
});

describe('the no-session canonical step', () => {
  const step = canonicalScenarios.find((scenario) => scenario.id === 'no-session')!.steps![0]!;
  const shellCall = {
    name: SHELL_TOOL,
    status: 'completed' as const,
    command: 'git log --oneline -1',
    output: 'd664784 seed\n',
  };
  const scenario = definition([step], { id: 'no-session', title: 'Без workflow-сессии' });

  test('repeats in the same session, as the registry declares, until an attempt is clean', async () => {
    // The first attempt adds a second shell call, which the boundary of an unmanaged session
    // does not allow; the repeat is what the read-only retry policy is for.
    const noisy = turn({
      toolCalls: [
        shellCall,
        { name: SHELL_TOOL, status: 'completed', command: 'echo seed', output: 'seed\n' },
      ],
    });
    const { host, calls } = makeHost([noisy, turn({ toolCalls: [shellCall] })]);

    const result = await runScenario(host, scenario, { attempts: 3 });

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(2);
    expect(calls.prompts).toHaveLength(2);
    // The failed attempt is not erased from the evidence.
    expect(result.evidence).toContain('попытка 1');
    expect(result.evidence).toContain('разрешено ровно одно действие');
  });

  test('fails when every attempt performs more than the allowed action', async () => {
    const noisy = turn({
      toolCalls: [
        shellCall,
        { name: SHELL_TOOL, status: 'completed', command: 'echo seed', output: 'seed\n' },
      ],
    });
    const { host } = makeHost([noisy]);

    const result = await runScenario(host, scenario, { attempts: 3 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.failureKind).toBe('model');
    expect(result.evidence).toContain('разрешено ровно одно действие');
    expect(result.evidence).toContain('«echo seed»');
  });

  test('fails when the command never ran, even though no workflow session exists', async () => {
    // "Nothing happened" must not read as "the plugin stayed out of the way".
    const { host } = makeHost([turn()]);

    const result = await runScenario(host, scenario, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.failureKind).toBe('model');
    expect(result.evidence).toContain('ни одного вызова инструмента');
  });

  test('fails on a different command that happens to print seed', async () => {
    // The proof is the command that ran, not text that looks like its output: `echo seed`
    // must not satisfy a scenario that asked for `git log --oneline -1`.
    const { host } = makeHost([
      turn({
        toolCalls: [
          { name: SHELL_TOOL, status: 'completed', command: 'echo seed', output: 'seed\n' },
        ],
      }),
    ]);

    const result = await runScenario(host, scenario, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('«echo seed»');
    expect(result.evidence).toContain('ожидалась «git log --oneline -1»');
  });

  test('fails when the host reported no command at all, because nothing is proven', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [{ name: SHELL_TOOL, status: 'completed', output: 'd664784 seed\n' }] }),
    ]);

    const result = await runScenario(host, scenario, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('команда не сообщена');
  });

  test('fails when a non-shell tool was used', async () => {
    const { host } = makeHost([
      turn({
        toolCalls: [
          { name: 'read', status: 'completed', command: 'git log --oneline -1', output: 'seed\n' },
        ],
      }),
    ]);

    const result = await runScenario(host, scenario, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('разрешён инструмент «shell»');
  });

  test('accepts the same command with incidental spacing', async () => {
    const { host } = makeHost([
      turn({
        toolCalls: [
          {
            name: SHELL_TOOL,
            status: 'completed',
            command: '  git   log --oneline -1 ',
            output: 'd664784 seed\n',
          },
        ],
      }),
    ]);

    const result = await runScenario(host, scenario, { attempts: 1 });

    expect(result.status).toBe('pass');
  });

  test('fails when the plugin wrote a workflow session for the unmanaged session', async () => {
    const { host } = makeHost([turn({ toolCalls: [shellCall] }, planning)], { state: planning });

    const result = await runScenario(host, scenario, { attempts: 1 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('плагин записал сессию workflow');
  });
});
