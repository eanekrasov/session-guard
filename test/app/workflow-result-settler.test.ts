import { describe, expect, test } from 'bun:test';

import { createSession } from '../../src/session/session-store.ts';
import type { ActiveOperation } from '../../src/session/session-schema.ts';
import { WorkflowResultSettlerImpl } from '../../src/app/workflow-result-settler.ts';
import { createTask } from '../support/task-factory.ts';

function sessionWithRun() {
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

describe('WorkflowResultSettler', () => {
  test('finishes a task call without parsing text as a gate verdict', async () => {
    const session = sessionWithRun();
    const entries: string[] = [];
    const settler = new WorkflowResultSettlerImpl(async (_level, message) => {
      entries.push(message);
    });

    await settler.settle({
      tool: 'task',
      session,
      callID: 'call-1',
      args: { subagent_type: 'reviewer' },
      output: { output: 'Review complete; no marker required.' },
      projectDir: '',
      profilesDir: '',
      operation: session.activeOperations['call-1'] as ActiveOperation,
    });

    expect(session.loopRuns['run-1']?.gates).toEqual({});
    expect(session.activeOperations).toEqual({});
    expect(session.verdictProvenance).toEqual({});
    expect(entries.some((message) => message.includes('workflow-result.missing'))).toBe(false);
  });
});
