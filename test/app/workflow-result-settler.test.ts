import { describe, expect, test } from 'bun:test';

import { createSession } from '../../src/session/session-store.ts';
import type { WorkflowSession, ActiveOperation } from '../../src/session/session-schema.ts';
import { WorkflowResultSettlerImpl } from '../../src/app/workflow-result-settler.ts';
import { createTask } from '../support/task-factory.ts';

function sessionWithRun(): WorkflowSession {
  const session = createSession('settler', 'profile', 'schema', 'execution');
  session.tasks.implementation = [createTask({ id: 'task-1', status: 'running' })];
  session.loopRuns['run-1'] = {
    id: 'run-1',
    taskId: 'task-1',
    listKey: 'implementation',
    ancestry: [],
    stage: 'verify',
    status: 'running',
    gates: {},
    round: 0,
  };
  session.activeOperations['call-1'] = {
    callId: 'call-1',
    runId: 'run-1',
    taskId: 'task-1',
    agent: 'reviewer',
    status: 'running',
    startedAt: new Date().toISOString(),
    round: 0,
    kind: 'task',
  };
  session.verdictProvenance['call-1'] = { runId: 'run-1', round: 0 };
  return session;
}

const engine = {
  getLoopStage: () => ({ stages: { verify: { gates: ['review'] } } }),
  getStages: () => ({}),
  evaluateGuard: () => true,
} as never;

describe('WorkflowResultSettler', () => {
  test('settles a supplied session without loading or saving it', async () => {
    const session = sessionWithRun();
    let loads = 0;
    let saves = 0;
    const settler = new WorkflowResultSettlerImpl({
      resolveEngine: async () => engine,
      log: async () => undefined,
      load: async () => {
        loads += 1;
        return null;
      },
      save: async () => {
        saves += 1;
      },
    });

    await settler.settle({
      tool: 'task',
      session,
      callID: 'call-1',
      args: { subagent_type: 'reviewer' },
      output: {
        output:
          '<workflow-result>{"gate":"review","status":"pass","summary":"ok","evidence":["ok"]}</workflow-result>',
      },
      projectDir: '/tmp/test-project',
      profilesDir: '/tmp/test-profiles',
      operation: session.activeOperations['call-1'] as ActiveOperation,
    });

    expect(session.loopRuns['run-1']?.gates).toEqual({ review: 'passed' });
    expect(session.tasks.implementation?.[0]?.status).toBe('completed');
    expect(loads).toBe(0);
    expect(saves).toBe(0);
  });

  test('replay and malformed markers do not mutate settlement state', async () => {
    const session = sessionWithRun();
    const settler = new WorkflowResultSettlerImpl({
      resolveEngine: async () => engine,
      log: async () => undefined,
      load: async () => null,
      save: async () => undefined,
    });
    const input = {
      tool: 'task',
      session,
      callID: 'call-1',
      args: { subagent_type: 'reviewer' },
      output: { output: 'not a workflow result' },
      projectDir: '/tmp/test-project',
      profilesDir: '/tmp/test-profiles',
      operation: session.activeOperations['call-1'] as ActiveOperation,
    };

    await settler.settle(input);
    expect(session.loopRuns['run-1']?.gates).toEqual({});
    expect(session.activeOperations['call-1']).toBeUndefined();

    input.output.output =
      '<workflow-result>{"gate":"review","status":"pass","summary":"ok","evidence":["ok"]}</workflow-result>';
    await settler.settle(input);
    expect(session.loopRuns['run-1']?.gates).toEqual({});
  });

  test('rejects a verdict from a completed round without recording it', async () => {
    const session = sessionWithRun();
    session.loopRuns['run-1']!.round = 1;
    const settler = new WorkflowResultSettlerImpl({
      resolveEngine: async () => engine,
      log: async () => undefined,
    });

    const output = {
      output:
        '<workflow-result>{"gate":"review","status":"pass","summary":"late","evidence":["late"]}</workflow-result>',
    };
    await settler.settle({
      tool: 'task',
      session,
      callID: 'call-1',
      args: { subagent_type: 'reviewer' },
      output,
      projectDir: '/tmp/test-project',
      profilesDir: '/tmp/test-profiles',
      operation: session.activeOperations['call-1'] as ActiveOperation,
    });

    expect(output.output).toContain('[workflow-result-stale]');
    expect(session.loopRuns['run-1']?.gates).toEqual({});
    expect(session.verifications).toHaveLength(0);
  });
});
