import { describe, expect, test } from 'bun:test';
import { formatDetailsLines, formatSectionLines, parseRuntimeState } from '../../src/tui/tui.ts';
import { toSessionSnapshot } from '../../src/types/session-snapshot.ts';
import { WorkflowSessionSchema } from '../../src/session/session-schema.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

function makeSession(overrides: Record<string, unknown> = {}): WorkflowSession {
  return WorkflowSessionSchema.parse({
    sessionId: 'ses_root',
    profileId: 'base',
    schemaId: 'session-guard',
    currentStage: 'planning',
    revision: 1,
    updatedAt: '2026-08-23T00:00:00.000Z',
    stageGateResults: [
      { stage: 'planning', id: 'review', status: 'pending' },
      { stage: 'planning', id: 'qa', status: 'pending' },
    ],
    retryBudgets: { cycles: { attempts: 0, maximum: 3 } },
    title: 'Test Task',
    ...overrides,
  });
}

interface TaskInput {
  id: string;
  title: string;
  status: 'running' | 'pending' | 'completed';
  branch: string;
}

function makeTasks(count: number): { implementation: TaskInput[] } {
  return {
    implementation: Array.from({ length: count }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      status: index === 0 ? 'running' : 'pending',
      branch: `feature/task-${index}`,
    })),
  };
}

function makeSnapshot(
  overrides: Record<string, unknown> = {}
): ReturnType<typeof toSessionSnapshot> {
  return toSessionSnapshot(makeSession(overrides));
}

describe('parseRuntimeState', () => {
  test('сессия со стадией даёт вид панели', () => {
    const r = parseRuntimeState(
      makeSession({
        currentStage: 'code',
        approvals: [
          {
            type: 'plan',
            callId: 'call_1',
            status: 'granted',
            evidence: 'sha256:abc',
          },
        ],
        tasks: makeTasks(3),
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rootSessionID).toBe('ses_root');
    expect(r.value.revision).toBe(1);
    expect(r.value.completedTasks).toBe(0);
    expect(r.value.totalTasks).toBe(3);
    expect(r.value.stage).toBe('code');
  });

  test('пустая стадия — единственный настоящий отказ', () => {
    const r = parseRuntimeState(makeSession({ currentStage: '' }));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('no_stage');
  });

  test('currentStage=planning returns planning', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'planning' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('planning');
  });

  test('currentStage=code returns code', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'code', tasks: makeTasks(2) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('code');
  });

  test('currentStage=commit returns commit', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'commit' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('commit');
  });

  test('currentStage=done returns done', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'done' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('done');
  });

  test('unknown stage falls back to first stage', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'unknown_stage' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('planning');
  });

  test('approvals round-trip through view', () => {
    const r = parseRuntimeState(
      makeSession({
        approvals: [
          { type: 'plan', callId: 'c1', status: 'granted' },
          { type: 'commit', callId: 'c2', status: 'pending' },
        ],
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.gates.some((g) => g.id === 'review' && g.status === 'pending')).toBe(true);
    expect(r.value.gates.some((g) => g.id === 'review' && g.status === 'granted')).toBe(false);
  });

  test('gate statuses derived from stageGateResults', () => {
    const r = parseRuntimeState(
      makeSession({
        stageGateResults: [
          { stage: 'planning', id: 'invariants', status: 'passed' },
          { stage: 'planning', id: 'review', status: 'failed' },
        ],
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gates = r.value.gates;
    expect(gates.some((g) => g.id === 'invariants' && g.status === 'passed')).toBe(true);
    expect(gates.some((g) => g.id === 'review' && g.status === 'failed')).toBe(true);
  });

  test('active operations mapped to callId', () => {
    const r = parseRuntimeState(
      makeSession({
        activeOperations: {
          call_1: {
            callId: 'call_1',
            runId: 'run-1',
            taskId: 'task-1',
            agent: 'code',
            status: 'running',
            startedAt: '2026-08-23T00:00:00.000Z',
            round: 0,
            kind: 'mutation',
            result: 'output_ready',
          },
        },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.activeOperations).toHaveLength(1);
    expect(r.value.activeOperations[0].callId).toBe('call_1');
    expect(r.value.activeOperations[0].agent).toBe('code');
    expect(r.value.activeOperations[0].outputReady).toBe(true);
  });

  test('retry budgets exposed', () => {
    const r = parseRuntimeState(
      makeSession({
        retryBudgets: { cycles: { attempts: 2, maximum: 3 } },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.retryBudgets).toHaveLength(1);
    expect(r.value.retryBudgets[0]).toMatchObject({ key: 'cycles', attempts: 2, maximum: 3 });
  });

  test('prevStage/nextStage neighbours from base STAGES', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'code' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.prevStage).toBe('tasks_ready');
    expect(r.value.nextStage).toBe('execution');
  });

  test('unknown stage has no neighbours', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'unknown' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.prevStage).toBeNull();
    expect(r.value.nextStage).toBeNull();
  });

  test('completed tasks counted', () => {
    const tasks = makeTasks(3);
    tasks.implementation[1].status = 'completed';
    const r = parseRuntimeState(makeSession({ tasks, currentStage: 'code' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.completedTasks).toBe(1);
    expect(r.value.totalTasks).toBe(3);
  });

  test('verifications included in view', () => {
    const r = parseRuntimeState(
      makeSession({
        verifications: [
          { gate: 'bug', status: 'confirmed' },
          { gate: 'review', status: 'rejected' },
        ],
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = r.value;
    expect(view.gates.some((g) => g.id === 'bug' && g.status === 'confirmed')).toBe(true);
    expect(view.gates.some((g) => g.id === 'review' && g.status === 'rejected')).toBe(true);
  });

  test('taskGates include checks from run', () => {
    const runs = {
      'run-1': {
        id: 'run-1',
        taskId: 'task-1',
        listKey: 'implementation',
        stage: 'code',
        status: 'completed',
      },
      'run-2': {
        id: 'run-2',
        taskId: 'task-2',
        listKey: 'implementation',
        stage: 'review',
        status: 'completed',
      },
    };
    const view = parseRuntimeState(
      makeSession({
        currentStage: 'code',
        loopRuns: runs,
        tasks: {
          implementation: [
            { id: 'task-1', status: 'completed' },
            { id: 'task-2', status: 'running' },
          ],
        },
      })
    );
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const tg = view.value.taskGates;
    expect(tg.some((t) => t.taskId === 'task-1' && t.stage === 'code')).toBe(true);
    expect(tg.some((t) => t.taskId === 'task-2' && t.stage === 'review')).toBe(true);
  });

  test('checks field shows run.checks when no gates', () => {
    const runs = {
      'run-1': {
        id: 'run-1',
        taskId: 'task-1',
        listKey: 'implementation',
        stage: 'code',
        status: 'completed',
      },
    };
    const r = parseRuntimeState(
      makeSession({
        currentStage: 'code',
        loopRuns: runs,
        tasks: { implementation: [{ id: 'task-1', status: 'completed' }] },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = r.value;
    const task1 = view.taskGates.find((t) => t.taskId === 'task-1');
    expect(task1?.checks).toBe('completed');
  });

  test('shows the verdict against the task and stage it was given for', () => {
    const runs = {
      'run-1': {
        id: 'run-1',
        taskId: 'task-1',
        listKey: 'implementation',
        stage: 'code',
        status: 'completed',
      },
      'run-2': {
        id: 'run-2',
        taskId: 'task-2',
        listKey: 'implementation',
        stage: 'review',
        status: 'completed',
      },
    };
    const view = parseRuntimeState(
      makeSession({
        currentStage: 'code',
        loopRuns: runs,
        tasks: {
          implementation: [
            { id: 'task-1', status: 'completed' },
            { id: 'task-2', status: 'running' },
          ],
        },
      })
    );
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const viewValue = view.value;
    const status = formatSectionLines(viewValue).join('\n');
    expect(status).toContain('task-1@verify');
    expect(status).not.toContain('task-2@code');
  });
});

describe('formatDetailsLines', () => {
  test('скалярные поля сессии выводятся построчно', () => {
    const lines = formatDetailsLines(makeSnapshot({ revision: 5, title: 'My Task' }));
    expect(lines.some((l) => l.startsWith('sessionId: ses_root'))).toBe(true);
    expect(lines.some((l) => l.startsWith('schemaVersion: 1'))).toBe(true);
    expect(lines.some((l) => l.startsWith('revision: 5'))).toBe(true);
    expect(lines.some((l) => l.startsWith('title: My Task'))).toBe(true);
  });

  test('one detail line per open call', () => {
    const lines = formatDetailsLines(
      makeSnapshot({
        activeOperations: {
          call_xyz: {
            callId: 'call_xyz',
            runId: 'run-1',
            taskId: 'task-1',
            agent: 'review',
            status: 'running',
            startedAt: '2026-08-23T00:00:00.000Z',
            result: 'output_ready',
          },
        },
      })
    );
    expect(lines).not.toBeNull();
    expect(
      lines!.some((l) =>
        l.startsWith('activeOperation: callID=call_xyz task=task-1 agent=review outputReady=true')
      )
    ).toBe(true);
  });

  test('tasks summary includes count and active index', () => {
    const lines = formatDetailsLines(
      makeSnapshot({
        tasks: [
          { id: 'task-0', status: 'running', title: 'Task 0', branch: 'feature/task-0' },
          { id: 'task-1', status: 'pending', title: 'Task 1', branch: 'feature/task-1' },
          { id: 'task-2', status: 'pending', title: 'Task 2', branch: 'feature/task-2' },
        ],
      })
    );
    expect(lines).not.toBeNull();
    expect(lines.some((l) => l.startsWith('tasks: 3'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  running=1 completed=0'))).toBe(true);
  });

  test('gates summary shows status per gate', () => {
    const lines = formatDetailsLines(
      makeSnapshot({
        gates: { invariants: 'passed', review: 'pending', qa: 'running' },
      })
    );
    expect(lines).not.toBeNull();
    expect(
      lines.some((l) => l.startsWith('gates: invariants=passed, review=pending, qa=running'))
    ).toBe(true);
  });

  test('changedFiles: counter + top-3 + +X ещё', () => {
    const lines = formatDetailsLines(makeSnapshot({}));
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('changedFiles: 4'))).toBe(false);
  });

  test('retry budget shows attempts/maximum', () => {
    const lines = formatDetailsLines(
      makeSnapshot({
        retryBudgets: { cycles: { attempts: 2, maximum: 3 } },
      })
    );
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('retry.cycles: 2/3'))).toBe(true);
  });

  test('поля схемы, не названные явно, всё равно попадают в дамп', () => {
    const lines = formatDetailsLines(makeSnapshot({ deliveryReceipt: 'a'.repeat(40) }));
    expect(lines.some((l) => l.startsWith('deliveryReceipt:'))).toBe(true);
  });

  test('long values truncated', () => {
    const lines = formatDetailsLines(makeSnapshot({ title: 'T'.repeat(200) }));
    expect(lines!.every((l) => l.length <= 100)).toBe(true);
  });
});
