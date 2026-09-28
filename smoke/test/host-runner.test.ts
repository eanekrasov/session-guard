import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SmokeHost } from '../src/host/facade.ts';
import { SHELL_TOOL, pluginObservationFrom } from '../src/host/transport.ts';
import { canonicalScenarios, findScenario } from '../src/registry.ts';
import type {
  HostKind,
  MigratedScenarioDefinition,
  NormalizedInteraction,
  NormalizedToolCall,
  PromptInput,
  PromptResult,
  ScenarioStep,
  SmokeWorkflowState,
} from '../src/host/types.ts';
import { runScenario, statePollBudgetMs, DEFAULT_POLL_BUDGET_MS } from '../src/runner.ts';

const BLOCKED_REASONS = [
  'adapter_contract_mismatch',
  'required_host_capability_unavailable',
  'indeterminate_mutation',
];

function turn(
  overrides: Partial<PromptResult['turn']> = {},
  state: SmokeWorkflowState | null = null,
  interactions?: NormalizedInteraction[]
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
    ...(interactions === undefined ? {} : { interactions }),
  };
}

function makeHost(
  replies: Array<PromptResult | Error>,
  options: {
    kind?: HostKind;
    state?: SmokeWorkflowState | null;
    stateError?: boolean;
    /** A queue of durable states for successive reads; the last one repeats. */
    states?: Array<SmokeWorkflowState | null>;
  } = {}
): {
  host: SmokeHost;
  calls: { created: string[]; prompts: PromptInput[]; closed: string[]; stateReads: number };
} {
  const kind = options.kind ?? 'v1';
  const calls = {
    created: [] as string[],
    prompts: [] as PromptInput[],
    closed: [] as string[],
    stateReads: 0,
  };
  let index = 0;
  let stateIndex = 0;
  return {
    calls,
    host: {
      kind,
      workDir: '/tmp/smoke-mock-workspace',
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
        calls.stateReads += 1;
        if (options.stateError === true) throw new Error('[ERROR] damaged state file');
        if (options.states !== undefined && options.states.length > 0) {
          const queued = options.states[Math.min(stateIndex, options.states.length - 1)];
          stateIndex += 1;
          return queued;
        }
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
      workDir: '/tmp/smoke-mock-workspace',
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

  test('reads the poll budget from the environment and refuses an unusable one', () => {
    expect(statePollBudgetMs({})).toBe(DEFAULT_POLL_BUDGET_MS);
    expect(statePollBudgetMs({ HOST_SMOKE_STATE_POLL_MS: '' })).toBe(DEFAULT_POLL_BUDGET_MS);
    expect(statePollBudgetMs({ HOST_SMOKE_STATE_POLL_MS: '2500' })).toBe(2_500);
    expect(statePollBudgetMs({ HOST_SMOKE_STATE_POLL_MS: 'soon' })).toBe(DEFAULT_POLL_BUDGET_MS);
    expect(statePollBudgetMs({ HOST_SMOKE_STATE_POLL_MS: '-5' })).toBe(DEFAULT_POLL_BUDGET_MS);
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

describe('the plan-consent canonical scenario', () => {
  const scenario = canonicalScenarios.find((entry) => entry.id === 'plan-consent')!;
  const definition = {
    id: scenario.id,
    title: scenario.title,
    migrationState: 'migrated' as const,
    agent: scenario.agent,
    steps: scenario.steps!,
  };
  const planning: SmokeWorkflowState = {
    sessionId: 'ses-1',
    status: 'running',
    currentStage: 'planning',
    durableMutation: 'applied',
  };
  const consented: SmokeWorkflowState = {
    ...planning,
    currentStage: 'tasks_ready',
    refs: { plan: 'plan.md' },
  };
  const granted = {
    kind: 'question' as const,
    id: 'q-1',
    isConsent: true,
    decision: 'grant' as const,
    label: 'grant',
    offered: ['grant', 'decline'],
  };

  test('passes on the durable outcome of the answer, not on the answer alone', async () => {
    const { host, calls } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn({ toolCalls: [] }, consented, [granted]),
    ]);

    const result = await runScenario(host, definition, { attempts: 1 });

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(2);
    expect(result.evidence).toContain('stage=tasks_ready');
    expect(calls.prompts).toHaveLength(2);
  });

  test('fails when no interaction reached the facade, even if the state moved', async () => {
    // A plugin that approved consent by itself (or a scenario that never asked) proves nothing
    // about the consent path, so the interaction is part of the contract.
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn({ toolCalls: [] }, consented),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, pollBudgetMs: 50 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('согласие не было задано');
  });

  test('fails when the grant came from a question that was not the consent request', async () => {
    // The model can invent an extra question and the operator answers it by policy; a plausible
    // state must not let that stand in for the consent path.
    const invented = {
      kind: 'question' as const,
      id: 'q-2',
      isConsent: false,
      decision: 'grant' as const,
      label: 'grant',
      offered: ['grant', 'decline'],
    };
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn({ toolCalls: [] }, consented, [invented]),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, pollBudgetMs: 50 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('consent=false');
    expect(result.evidence).toContain('согласие не было задано');
  });

  test('fails when the plan reference was not recorded', async () => {
    const noRef = { ...planning, currentStage: 'tasks_ready' };
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn({ toolCalls: [] }, noRef, [granted]),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, pollBudgetMs: 50 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('ссылка на план не записана');
  });

  test('fails when the state machine did not leave planning', async () => {
    // The plan reference is recorded, but the machine has not moved: that is not consent applied.
    const planRecorded = { ...planning, refs: { plan: 'plan.md' } };
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn({ toolCalls: [] }, planRecorded, [granted]),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, pollBudgetMs: 50 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('ожидалась tasks_ready');
  });

  test('confirms the outcome from a later durable read without re-sending the consent', async () => {
    // The answer landed after the turn ended: `poll-state` reads the store instead of asking
    // again, and the evidence says so.
    const { host, calls } = makeHost(
      [turn({ toolCalls: [] }, planning), turn({ toolCalls: [] }, planning, [granted])],
      {
        states: [planning, planning, consented],
      }
    );

    const result = await runScenario(host, definition, {
      attempts: 1,
      pollBudgetMs: 400,
      pollIntervalMs: 10,
    });

    expect(result.status).toBe('pass');
    // Two prompts: the create step and the consent step — never a second consent.
    expect(calls.prompts).toHaveLength(2);
    expect(result.evidence).toContain('retry=poll-state');
    expect(result.evidence).toContain('stage=tasks_ready');
  });

  test('blocks an unproven outcome after the consent prompt was sent once', async () => {
    const { host, calls } = makeHost(
      [turn({ toolCalls: [] }, planning), turn({ status: 'timed-out' }, planning)],
      {
        states: [planning, planning, planning],
      }
    );

    const result = await runScenario(host, definition, {
      attempts: 1,
      pollBudgetMs: 40,
      pollIntervalMs: 10,
    });

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(calls.prompts).toHaveLength(2);
    expect(result.evidence).toContain('poll-state не подтвердил ожидание');
    expect(result.evidence).toContain('durableMutation=applied');
  });
});

describe('scenario sources stay free of transport specifics', () => {
  test('neither the registry nor the scenarios reach past the facade', async () => {
    // The scenario layer must describe semantics only: no endpoints, no generated client, no
    // transport module. This is what keeps one scenario runnable on both host kinds.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const forbidden = [
      '/question',
      'session.form',
      './host/v1-transport',
      './host/v2-transport',
      './v2-client',
      '../v2-client',
      'OpenCode.make',
    ];
    const files = ['src/registry.ts'];
    const scenarioDir = join(import.meta.dirname, '../src/scenarios');

    for (const file of files) {
      const source = await readFile(join(import.meta.dirname, '..', file), 'utf-8');
      for (const needle of forbidden) {
        expect(source).not.toContain(needle);
      }
    }
    // The canonical scenarios live in the registry; the legacy per-kind files are the baseline
    // this stage is migrating away from and are not part of the shared path.
    expect(scenarioDir.length).toBeGreaterThan(0);
  });
});

describe('the task-control canonical scenario', () => {
  const scenario = canonicalScenarios.find((entry) => entry.id === 'task-control')!;
  const definition = {
    id: scenario.id,
    title: scenario.title,
    migrationState: 'migrated' as const,
    agent: scenario.agent,
    steps: scenario.steps!,
  };
  const withTasks = (status: string): SmokeWorkflowState => ({
    sessionId: 'ses-1',
    status: 'running',
    currentStage: 'planning',
    tasks: { implementation: [{ status }] },
    durableMutation: 'applied',
  });
  const tasksSet = turn({ toolCalls: [] }, withTasks('pending'));
  const workerAttempt = (overrides: Partial<NormalizedToolCall> = {}) =>
    turn(
      {
        toolCalls: [
          {
            name: 'workflow-tasks-set-status',
            status: 'completed',
            output:
              'workflow-tasks-set-status is refused: workflow task state is controlled by [orchestrator]',
            ...overrides,
          },
        ],
      },
      withTasks('pending')
    );

  test('runs the orchestrator mutation and the worker attempt as different agents', async () => {
    // The worker step names its agent per step: V1 carries it on the message, V2 switches the
    // session, and the guard is what makes the refusal meaningful.
    const { host, calls } = makeHost([
      turn({ toolCalls: [] }, withTasks('pending')),
      tasksSet,
      workerAttempt(),
    ]);

    const result = await runScenario(host, definition, { attempts: 1 });

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(3);
    expect(calls.prompts.map((input) => input.agent)).toEqual([
      'orchestrator',
      'orchestrator',
      'coder',
    ]);
  });

  test('accepts a structured refusal marker, and the plugin sentence as the documented fallback', async () => {
    for (const attempt of [workerAttempt({ refused: true, output: undefined }), workerAttempt()]) {
      const { host } = makeHost([turn({ toolCalls: [] }, withTasks('pending')), tasksSet, attempt]);
      const result = await runScenario(host, definition, { attempts: 1 });
      expect(result.status).toBe('pass');
    }
  });

  test('fails when the worker actually moved the task status', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, withTasks('pending')),
      tasksSet,
      turn({ toolCalls: [] }, withTasks('completed')),
    ]);

    const result = await runScenario(host, definition, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('worker изменил статус задачи');
  });

  test('fails when the worker never called the tool, so no refusal was observed', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, withTasks('pending')),
      tasksSet,
      turn({ toolCalls: [{ name: 'read', status: 'completed' }] }, withTasks('pending')),
    ]);

    const result = await runScenario(host, definition, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('worker не вызывал');
  });

  test('fails when the tool ran without any refusal, because the guard did not answer', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, withTasks('pending')),
      tasksSet,
      workerAttempt({ output: 'Updated task-0 to completed' }),
    ]);

    const result = await runScenario(host, definition, { attempts: 1 });

    expect(result.status).toBe('fail');
    if (result.status !== 'fail') throw new Error('expected a failure');
    expect(result.evidence).toContain('отказ не подтверждён');
  });

  test('blocks an unprovable orchestrator mutation and never repeats it', async () => {
    // The mutation's outcome never lands in the store, so it cannot be proven either way.
    const noTasks: SmokeWorkflowState = { ...withTasks('pending'), tasks: {} };
    const { host, calls } = makeHost(
      [turn({ toolCalls: [] }, withTasks('pending')), turn({ status: 'timed-out' }, noTasks)],
      { states: [noTasks, noTasks] }
    );

    const result = await runScenario(host, definition, {
      attempts: 1,
      pollBudgetMs: 40,
      pollIntervalMs: 10,
    });

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    // create + the one task-list mutation: the mutation is never sent twice.
    expect(calls.prompts).toHaveLength(2);
  });
});

describe('the commit/mutation canonical scenarios', () => {
  const gate = scenario('commit-gate');
  const cwd = scenario('commit-cwd');
  const mismatch = scenario('commit-mismatch');

  function scenario(id: string): MigratedScenarioDefinition {
    const found = findScenario(id);
    if (found?.migrationState !== 'migrated') throw new Error(`${id} не мигрирован`);
    return found;
  }

  /** Настоящий git-проект: проверки HEAD должны быть проверками, а не декларацией. */
  function workspace(): { workDir: string; commit: (message: string) => string } {
    const workDir = mkdtempSync(join(tmpdir(), 'smoke-workspace-'));
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: workDir, encoding: 'utf-8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'smoke@example.com']);
    git(['config', 'user.name', 'smoke']);
    git(['commit', '-q', '--allow-empty', '-m', 'seed']);
    return {
      workDir,
      commit: (message: string) => {
        git(['commit', '-q', '--allow-empty', '-m', message]);
        return git(['rev-parse', 'HEAD']);
      },
    };
  }

  /**
   * Хост, который отдаёт заготовленные ходы и читает состояние последнего хода.
   *
   * Ходы — фабрики, а не значения: сценарий поставки доказывает мутацию сменой HEAD, поэтому
   * тест обязан уметь сходить в git между промптом и проверкой ожидания.
   */
  function commitHost(
    workDir: string,
    turns: Array<() => PromptResult>
  ): { host: SmokeHost; calls: { prompts: PromptInput[]; closed: string[] } } {
    const calls = { prompts: [] as PromptInput[], closed: [] as string[] };
    let index = 0;
    let state: SmokeWorkflowState | null = null;
    return {
      calls,
      host: {
        kind: 'v1',
        workDir,
        async createSession() {
          return { id: 'ses-1', hostKind: 'v1' };
        },
        async runPrompt(_session, input) {
          calls.prompts.push(input);
          const reply = turns[Math.min(index, turns.length - 1)]!();
          index += 1;
          state = reply.workflowState;
          return reply;
        },
        async readWorkflowState() {
          return state;
        },
        async closeSession(session) {
          calls.closed.push(session.id);
        },
      },
    };
  }

  const planningTurn = (): PromptResult => turn({ toolCalls: [] }, planning);
  const consentTurn = (): PromptResult =>
    turn(
      { toolCalls: [] },
      { ...planning, currentStage: 'tasks_ready', refs: { plan: 'plan.md' } }
    );
  const taskSetTurn = (): PromptResult =>
    turn({ toolCalls: [] }, { ...planning, currentStage: 'execution' });
  const writeTurn = (): PromptResult =>
    turn(
      { toolCalls: [] },
      { ...planning, currentStage: 'execution', changedFiles: ['src/smoke-1.ts'] }
    );
  const doneTurn = (): PromptResult =>
    turn(
      { toolCalls: [] },
      {
        ...planning,
        currentStage: 'execution',
        changedFiles: ['src/smoke-1.ts'],
        tasks: { implementation: [{ id: 'task-0', status: 'completed' }] },
      }
    );
  const reviewTurn = (): PromptResult =>
    turn(
      { toolCalls: [] },
      {
        ...planning,
        currentStage: 'validation',
        stageGates: { review: 'passed' },
      }
    );
  const deliveredState = (receipt: string): SmokeWorkflowState => ({
    ...planning,
    currentStage: 'commit',
    deliveryReceipt: receipt,
  });
  const deliveredTurn = (receipt: string): PromptResult =>
    turn({ toolCalls: [] }, deliveredState(receipt));
  const verifyTurn = (): PromptResult =>
    turn({ toolCalls: [] }, { ...planning, currentStage: 'commit' });
  const shellCall = (command: string, refused: boolean) => ({
    name: SHELL_TOOL,
    status: 'completed' as const,
    command,
    ...(refused ? { refused: true } : {}),
  });
  const earlyCommand = 'bun run commit-task.ts -m "smoke: too early"';
  const deliverCommand = 'bun run commit-task.ts -m "smoke: deliver"';
  const mismatchCommand = 'bun run commit-task.ts -m "smoke: sweep"';
  const prepTurns = (): Array<() => PromptResult> => [
    planningTurn,
    consentTurn,
    taskSetTurn,
    writeTurn,
    doneTurn,
    reviewTurn,
    verifyTurn,
  ];

  test('commit-gate: passes on a refused early commit that left HEAD alone', async () => {
    const space = workspace();
    const { host, calls } = commitHost(space.workDir, [
      planningTurn,
      () => turn({ toolCalls: [shellCall(earlyCommand, true)] }, planning),
    ]);

    const result = await runScenario(host, gate, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('delivery=none');
    expect(calls.closed).toEqual(['ses-1']);
  });

  test('commit-gate: fails when the early commit moved HEAD', async () => {
    const space = workspace();
    const { host } = commitHost(space.workDir, [
      planningTurn,
      () => {
        space.commit('too early');
        return turn({ toolCalls: [shellCall(earlyCommand, true)] }, planning);
      },
    ]);

    const result = await runScenario(host, gate, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('HEAD переместился');
  });

  test('commit-gate: fails when the guarded command ran instead of being refused', async () => {
    const space = workspace();
    const { host } = commitHost(space.workDir, [
      planningTurn,
      () => turn({ toolCalls: [shellCall(earlyCommand, false)] }, planning),
    ]);

    const result = await runScenario(host, gate, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('должна была быть отклонена');
  });

  test('commit-gate: fails when a receipt was recorded anyway', async () => {
    const space = workspace();
    const { host } = commitHost(space.workDir, [
      planningTurn,
      () => turn({ toolCalls: [shellCall(earlyCommand, true)] }, deliveredState('receipt-1')),
    ]);

    const result = await runScenario(host, gate, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('записана квитанция о поставке');
  });

  test('commit-cwd: passes when the delivery moved HEAD and the receipt matches it', async () => {
    const space = workspace();
    const { host, calls } = commitHost(space.workDir, [
      ...prepTurns(),
      () => {
        const head = space.commit('smoke: deliver');
        return deliveredTurn(head);
      },
    ]);

    const result = await runScenario(host, cwd, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('delivery=receipt:');
    expect(calls.closed).toEqual(['ses-1']);
  });

  test('commit-cwd: fails when the receipt does not match HEAD', async () => {
    const space = workspace();
    const { host } = commitHost(space.workDir, [
      ...prepTurns(),
      () => {
        space.commit('smoke: deliver');
        return deliveredTurn('deadbeefdeadbeef');
      },
    ]);

    const result = await runScenario(host, cwd, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('не соответствует HEAD');
  });

  test('commit-mismatch: passes when the extra file left HEAD moved without a receipt', async () => {
    const space = workspace();
    const { host } = commitHost(space.workDir, [
      ...prepTurns(),
      () => {
        space.commit('smoke: sweep');
        return turn({ toolCalls: [shellCall(mismatchCommand, true)] }, planning);
      },
    ]);

    const result = await runScenario(host, mismatch, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('delivery=none');
    // Подготовка шага — это то, что делает коммит посторонним: файл создан до инструкции.
    expect(existsSync(join(space.workDir, 'unrelated.txt'))).toBe(true);
  });

  test('commit-mismatch: fails when the mismatched commit got a receipt', async () => {
    const space = workspace();
    const { host, calls } = commitHost(space.workDir, [
      ...prepTurns(),
      () => {
        space.commit('smoke: sweep');
        return turn({ toolCalls: [shellCall(mismatchCommand, true)] }, deliveredState('receipt-1'));
      },
    ]);

    const result = await runScenario(host, mismatch, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('получил квитанцию');
    expect(calls.closed).toEqual(['ses-1']);
  });

  test('an unprovable delivery blocks without repeating the commit prompt', async () => {
    const space = workspace();
    const { host, calls } = commitHost(space.workDir, [
      ...prepTurns(),
      () => turn({ status: 'timed-out', toolCalls: [shellCall(deliverCommand, false)] }, planning),
    ]);

    const result = await runScenario(host, cwd, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    // Восемь шагов — по одному промпту на шаг: commit-команда не повторялась.
    expect(calls.prompts).toHaveLength(8);
    expect(calls.closed).toEqual(['ses-1']);
  });
});

describe('the git-block canonical scenario', () => {
  const candidate = findScenario('git-block');
  if (candidate?.migrationState !== 'migrated') {
    throw new Error('registry не объявляет git-block мигрированным: сценарий нечего запускать');
  }
  const gitBlock = candidate;
  const commitCommand = 'git commit --allow-empty -m "smoke"';

  test('passes when the host refuses the direct commit and no delivery is recorded', async () => {
    const { host, calls } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn(
        {
          toolCalls: [
            {
              name: SHELL_TOOL,
              status: 'completed',
              command: commitCommand,
              refused: true,
            },
          ],
        },
        planning
      ),
    ]);

    const result = await runScenario(host, gitBlock, { attempts: 1 });

    // An expected refusal is the scenario's pass: the guard did what it is asked to do.
    expect(result.status).toBe('pass');
    expect(result.blockedReason).toBeUndefined();
    // workflow-create runs before the guard check, and the commit is never sent twice.
    expect(calls.prompts).toHaveLength(2);
    expect(calls.prompts[0]?.text).toContain('workflow-create');
    expect(result.evidence).toContain('delivery=none');
  });

  test('passes on the refusal the host reports when the structured marker is dropped', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn(
        {
          toolCalls: [
            {
              name: SHELL_TOOL,
              status: 'failed',
              command: commitCommand,
              error: '[ERROR] Refused: this stage does not declare the action git delivery',
            },
          ],
        },
        planning
      ),
    ]);

    const result = await runScenario(host, gitBlock, { attempts: 1 });

    expect(result.status).toBe('pass');
  });

  test('fails when the guarded commit ran instead of being refused', async () => {
    const { host, calls } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn(
        { toolCalls: [{ name: SHELL_TOOL, status: 'completed', command: commitCommand }] },
        planning
      ),
    ]);

    const result = await runScenario(host, gitBlock, { attempts: 1 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('commit выполнился, хотя должен был быть отклонён');
    expect(calls.prompts).toHaveLength(2);
  });

  test('fails when a delivery receipt was recorded despite the refusal', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn(
        {
          toolCalls: [
            { name: SHELL_TOOL, status: 'completed', command: commitCommand, refused: true },
          ],
        },
        { ...planning, deliveryReceipt: 'receipt-1' }
      ),
    ]);

    const result = await runScenario(host, gitBlock, { attempts: 1 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('квитанция о поставке');
  });

  test('fails when the workflow granted a delivery permit despite the refusal', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn(
        {
          toolCalls: [
            { name: SHELL_TOOL, status: 'completed', command: commitCommand, refused: true },
          ],
        },
        { ...planning, deliveryPermit: true }
      ),
    ]);

    const result = await runScenario(host, gitBlock, { attempts: 1 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('разрешение на поставку');
  });

  test('blocks an unprovable commit without repeating it', async () => {
    const { host, calls } = makeHost([
      turn({ toolCalls: [] }, planning),
      turn(
        {
          status: 'timed-out',
          toolCalls: [{ name: SHELL_TOOL, status: 'pending', command: commitCommand }],
        },
        planning
      ),
    ]);

    const result = await runScenario(host, gitBlock, { attempts: 1 });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    // The mutation is sent once: a repeat after a timeout could commit for real.
    expect(calls.prompts).toHaveLength(2);
  });
});

describe('the verify-loop canonical scenario', () => {
  const scenario = canonicalScenarios.find((entry) => entry.id === 'verify-loop')!;
  const definition = {
    id: scenario.id,
    title: scenario.title,
    migrationState: 'migrated' as const,
    agent: scenario.agent,
    steps: scenario.steps!,
  };
  // From the consent step on, the plugin holds the plan reference; the loop's later steps are
  // only reached once consent opened the tasks stage.
  const base = (extra: Partial<SmokeWorkflowState> = {}): SmokeWorkflowState => ({
    sessionId: 'ses-1',
    status: 'running',
    currentStage: 'execution',
    tasks: { implementation: [{ status: 'pending' }] },
    refs: { plan: 'plan.md' },
    durableMutation: 'applied',
    ...extra,
  });
  const planningState = base({ currentStage: 'planning', tasks: {} });
  const consentedState = base({ currentStage: 'tasks_ready', tasks: {} });
  const coderState = base({ changedFiles: ['src/smoke-1.ts'], runs: [{ stage: 'verify' }] });
  const reviewedState = base({
    changedFiles: ['src/smoke-1.ts'],
    runs: [{ stage: 'verify', gates: { review: 'passed' } }],
  });
  const completedState = base({
    changedFiles: ['src/smoke-1.ts'],
    runs: [{ stage: 'verify', gates: { review: 'passed', qa: 'passed' } }],
    tasks: { implementation: [{ status: 'completed' }] },
  });
  const granted = {
    kind: 'question' as const,
    id: 'q-1',
    isConsent: true,
    decision: 'grant' as const,
    label: 'grant',
    offered: ['grant', 'decline'],
  };

  test('runs the whole loop and proves each stage from durable state', async () => {
    const { host, calls } = makeHost([
      turn({ toolCalls: [] }, planningState),
      turn({ toolCalls: [] }, consentedState, [granted]),
      turn({ toolCalls: [] }, base()),
      turn({ toolCalls: [] }, coderState),
      turn({ toolCalls: [] }, reviewedState),
      turn({ toolCalls: [] }, completedState),
    ]);

    const result = await runScenario(host, definition, { attempts: 1 });

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(6);
    expect(calls.prompts).toHaveLength(6);
    expect(result.evidence).toContain('stage=execution');
  });

  test('fails when the core never recorded the file the coder was asked to write', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, planningState),
      turn({ toolCalls: [] }, consentedState, [granted]),
      turn({ toolCalls: [] }, base()),
      turn({ toolCalls: [] }, base({ runs: [{ stage: 'verify' }] })),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('файла src/smoke-1.ts нет среди изменённых ядром');
    // The wait is reported with what the store looked like, not just its duration.
    expect(result.evidence).toContain('ожидание шага:');
    expect(result.evidence).toContain('шаг занял:');
  });

  test('asks the host once more when a dispatched subagent left the state unmoved', async () => {
    const unmoved = base({ runs: [{ stage: 'code', status: 'running' }] });
    const { host, calls } = makeHost(
      [
        turn({ toolCalls: [] }, planningState),
        turn({ toolCalls: [] }, consentedState, [granted]),
        turn({ toolCalls: [] }, base()),
        // The coder's turn dispatched a subagent and ended; the store never moved.
        turn({ toolCalls: [{ name: 'subagent', status: 'completed' }] }, unmoved),
        // The read-only follow-up answers, and the store still does not move.
        turn({ toolCalls: [] }, unmoved),
      ],
      { states: [unmoved] }
    );

    const result = await runScenario(host, definition, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    // Four scenario turns, then exactly one follow-up: the mutation is never repeated.
    expect(calls.prompts).toHaveLength(5);
    expect(calls.prompts[4]?.text).toContain('Do not dispatch anything again');
    expect(result.evidence).toContain('повторного обращения');
  });

  test('fails when one verdict of two moves the task on', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, planningState),
      turn({ toolCalls: [] }, consentedState, [granted]),
      turn({ toolCalls: [] }, base()),
      turn({ toolCalls: [] }, coderState),
      turn({ toolCalls: [] }, base({ runs: [{ stage: 'qa', gates: { review: 'passed' } }] })),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('стадия перешла дальше по одному вердикту');
  });

  test('fails when the task never completed after both verdicts', async () => {
    const { host } = makeHost([
      turn({ toolCalls: [] }, planningState),
      turn({ toolCalls: [] }, consentedState, [granted]),
      turn({ toolCalls: [] }, base()),
      turn({ toolCalls: [] }, coderState),
      turn({ toolCalls: [] }, reviewedState),
      turn({ toolCalls: [] }, base({ runs: [{ stage: 'verify' }] })),
    ]);

    const result = await runScenario(host, definition, { attempts: 1, maxPollBudgetMs: 30 });

    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('статус задачи');
  });

  test('waits for a subagent outcome with the step budget, and never repeats the dispatch', async () => {
    // The turn may time out long before a subagent finishes; the step declares how long its
    // durable outcome may take, and the instruction is never sent again.
    const { host, calls } = makeHost(
      [
        turn({ toolCalls: [] }, planningState),
        turn({ toolCalls: [] }, consentedState, [granted]),
        turn({ toolCalls: [] }, base()),
        turn({ status: 'timed-out' }, base()),
      ],
      // Only the third read shows the coder's work: the step budget has to be what waits.
      { states: [base(), base(), coderState, coderState] }
    );

    const result = await runScenario(host, definition, {
      attempts: 1,
      pollBudgetMs: 10,
      maxPollBudgetMs: 100,
      pollIntervalMs: 5,
    });

    // The coder step waited out its own declared budget and passed; the reviewer step that
    // followed had no outcome to prove, so it blocked instead of asking again.
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected a blocked result');
    expect(result.blockedReason).toBe('indeterminate_mutation');
    expect(calls.prompts).toHaveLength(5);
    expect(result.evidence).toContain('review');
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
