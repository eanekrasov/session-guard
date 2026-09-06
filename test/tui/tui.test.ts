import { describe, expect, test } from 'bun:test';
import {
  formatDetailsLines,
  formatIdleLine,
  formatSectionLines,
  parseRuntimeState,
  type IdleReason,
} from '../../src/tui/tui.ts';

function makeV1Session(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: '00000000-0000-0000-0000-000000000001',
    sessionId: 'ses_root',
    revision: 1,
    updatedAt: '2026-08-23T00:00:00.000Z',
    approvals: [],

    tasks: [],
    currentTaskIndex: null,
    activeMutation: null,
    testStatus: {},
    gates: [
      { id: 'invariants', status: 'pending' },
      { id: 'review', status: 'pending' },
      { id: 'qa', status: 'pending' },
    ],
    commitPermit: null,
    deliveryReceipt: null,
    retryBudgets: { cycles: { attempts: 0, maximum: 3 } },
    processedEventIds: [],
    bugVerified: false,
    baselineHashes: {},
    changedFiles: [],
    title: 'Test Task',
    ...overrides,
  });
}

function makeTasks(count: number, manifest: string[] = ['dev', 'test', 'review', 'qa']) {
  return Array.from({ length: count }, (_, i) => ({
    id: `task_${i}`,
    title: `Task ${i}`,
    declaredScope: '',
    status: i === 0 ? 'active' : 'pending',
    branch: `feature/task-${i}`,
    manifest,
  }));
}

describe('parseRuntimeState', () => {
  test('non-numeric schemaVersion returns unknown_schema', () => {
    const r = parseRuntimeState(makeV1Session({ schemaVersion: 'abc' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_schema');
  });

  test('valid v1 session with currentStage returns Tui', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'code',
        approvals: [{ type: 'plan', status: 'granted' }],
        tasks: makeTasks(3),
        activeMutation: {
          callID: 'call_1',
          agent: 'code',
          startedAt: new Date().toISOString(),
          outputReady: false,
        },
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

  test('no currentStage and completely unrelated fields returns no_stage', () => {
    const r = parseRuntimeState(
      JSON.stringify({ schemaVersion: 1, sessionId: 's1', something: 'x' })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_stage');
  });

  test('planApproved false without currentStage returns planning (old fallback)', () => {
    const r = parseRuntimeState(makeV1Session({ planApproved: false }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stage).toBe('planning');
  });

  test('approvals granted without currentStage returns planning (old fallback)', () => {
    const r = parseRuntimeState(
      makeV1Session({
        approvals: [{ type: 'plan', status: 'granted' }],
        activeMutation: { callID: 'c1', agent: 'architect', startedAt: '', outputReady: false },
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stage).toBe('planning');
  });

  test('commitPermit without currentStage returns commit (old fallback)', () => {
    const r = parseRuntimeState(
      makeV1Session({
        commitPermit: {
          callID: 'commit_1',
          preCommitHead: 'a'.repeat(40),
          expectedFiles: [],
          createdAt: '',
        },
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stage).toBe('commit');
  });

  test('deliveryReceipt without currentStage returns commit (old fallback)', () => {
    const r = parseRuntimeState(makeV1Session({ deliveryReceipt: 'a'.repeat(40) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stage).toBe('commit');
  });

  test('currentStage=planning returns planning', () => {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'planning' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('planning');
  });

  test('currentStage=code returns code', () => {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'code', tasks: makeTasks(2) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('code');
  });

  test('currentStage=commit returns commit', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'commit',
        tasks: makeTasks(1).map((t) => {
          t.status = 'committed';
          return t;
        }),
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('commit');
  });

  test('currentStage=done returns done', () => {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'done' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe('done');
  });

  test('deriveDispatchStage: EMPTY when no activeMutation', () => {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'planning' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dispatchStage).toBe('EMPTY');
  });

  test('deriveDispatchStage: MUTATING when code active', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'code',
        activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: false },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dispatchStage).toBe('MUTATING');
  });

  test('deriveDispatchStage: BOTH_ACTIVE when verifierOperations present', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'code',
        activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: false },
        verifierOperations: { qa_task: true },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dispatchStage).toBe('BOTH_ACTIVE');
  });

  test('deriveDispatchStage: MUTATING_END when outputReady', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'code',
        activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: true },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dispatchStage).toBe('MUTATING_END');
  });

  test('completedTasks derived from committed tasks', () => {
    const tasks = makeTasks(3);
    tasks[1].status = 'committed';
    const r = parseRuntimeState(makeV1Session({ currentStage: 'code', tasks }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.completedTasks).toBe(1);
  });

  test('activeMutation parsed from session.activeMutation', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'code',
        activeMutation: { callID: 'call_abc123', agent: 'code', startedAt: '', outputReady: true },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.activeMutation?.taskId).toBe('call_abc123');
    expect(r.value.activeMutation?.agent).toBe('code');
    expect(r.value.activeMutation?.outputReady).toBe(true);
  });

  test('corrupted JSON returns parse_error without throwing', () => {
    expect(parseRuntimeState('{ broken')).toEqual({ ok: false, reason: 'parse_error' });
    expect(parseRuntimeState('')).toEqual({ ok: false, reason: 'parse_error' });
    expect(parseRuntimeState('null')).toEqual({ ok: false, reason: 'invalid_structure' });
    expect(parseRuntimeState('{}')).toEqual({ ok: false, reason: 'unknown_schema' });
  });

  test('empty sessionId returns missing_session_id', () => {
    const r = parseRuntimeState(makeV1Session({ sessionId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_session_id');
  });
});

describe('formatIdleLine', () => {
  const check = (reason: IdleReason) => {
    const line = formatIdleLine(reason);
    expect(line).toContain('▶');
    expect(line).toContain('✕');
    expect(line.length).toBeLessThanOrEqual(44);
  };

  test('no_session', () => check('no_session'));
  test('no_file', () => check('no_file'));
  test('parse_error', () => check('parse_error'));
  test('invalid_structure', () => check('invalid_structure'));
  test('unknown_schema', () => check('unknown_schema'));
  test('missing_session_id', () => check('missing_session_id'));
  test('no_stage', () => check('no_stage'));
});

describe('formatSectionLines', () => {
  function parse(overrides: Record<string, unknown> = {}) {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'code', ...overrides }));
    if (!r.ok) throw new Error(`parse failed: ${r.reason}`);
    return r.value;
  }

  test('contains stage name in first line', () => {
    const view = parse({
      approvals: [{ type: 'plan', status: 'granted' }],
      tasks: makeTasks(2, ['dev', 'test']),
      activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: false },
    });
    const lines = formatSectionLines(view);
    expect(lines[0]).toContain('code');
    expect(lines[0]).toContain('▶');
    expect(lines[0]).toContain('✕');
  });

  test('planning shown with prevStage=· nextStage=tasks_ready (compact at 37)', () => {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'planning' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = formatSectionLines(r.value);
    expect(lines[0]).toContain('planning');
    // При SIDEBAR_WIDTH=37 граф фаз переходит в compact — полное имя не влезает
    expect(lines[1]).toContain('·');
    expect(lines[1].length).toBeLessThanOrEqual(37);
  });

  test('all lines fit within sidebar width', () => {
    const view = parse({
      tasks: makeTasks(3),
      activeMutation: {
        callID: 'call_abcdefghijk',
        agent: 'code',
        startedAt: '',
        outputReady: false,
      },
    });
    const lines = formatSectionLines(view);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(37);
      expect(line.includes('\n')).toBe(false);
    }
  });

  test('third line shows gates and retry budgets', () => {
    const view = parse({
      tasks: makeTasks(1, ['dev']),
      activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: false },
      gates: [
        { id: 'invariants', status: 'passed' },
        { id: 'tests', status: 'pending' },
      ],
      retryBudgets: { code: { attempts: 2, maximum: 3 } },
    });
    const lines = formatSectionLines(view);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('✓invariants');
    expect(lines[2]).toContain('⏳tests');
    expect(lines[2]).toContain('retry.code=2/3');
  });

  test('third line overflows — shows +N more', () => {
    const view = parse({
      tasks: makeTasks(1),
      activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: false },
      gates: [
        { id: 'invariants', status: 'pending' },
        { id: 'review', status: 'running' },
        { id: 'qa', status: 'pending' },
        { id: 'extra_check', status: 'pending' },
        { id: 'security_audit', status: 'pending' },
      ],
      retryBudgets: { code: { attempts: 2, maximum: 3 }, infra: { attempts: 1, maximum: 3 } },
    });
    const lines = formatSectionLines(view);
    expect(lines).toHaveLength(3);
    // Должна быть хотя бы одна часть + суффикс счётчика остатка
    expect(lines[2]).toMatch(/⏳\w+/);
    expect(lines[2]).toMatch(/\+\d+/);
    expect(lines[2].length).toBeLessThanOrEqual(44);
  });

  test('third line overflows heavily — truncated with …', () => {
    const view = parse({
      tasks: makeTasks(1),
      activeMutation: { callID: 'c1', agent: 'code', startedAt: '', outputReady: false },
      gates: [
        { id: 'very_long_gate_name_that_takes_space', status: 'pending' },
        { id: 'another_really_long_one', status: 'running' },
      ],
      retryBudgets: { code: { attempts: 2, maximum: 3 }, infra: { attempts: 1, maximum: 3 } },
    });
    const lines = formatSectionLines(view);
    expect(lines).toHaveLength(3);
    expect(lines[2].length).toBeLessThanOrEqual(44);
  });

  test('graph line truncated for long stage names', () => {
    const r = parseRuntimeState(
      makeV1Session({
        currentStage: 'planning',
        gates: [],
        retryBudgets: {},
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = formatSectionLines(r.value);
    expect(lines).toHaveLength(3);
    expect(lines[1].length).toBeLessThanOrEqual(44);
  });
});

describe('task gates in the status line', () => {
  function parse(overrides: Record<string, unknown> = {}) {
    const r = parseRuntimeState(makeV1Session({ currentStage: 'execution', ...overrides }));
    if (!r.ok) throw new Error(`parse failed: ${r.reason}`);
    return r.value;
  }

  const runs = {
    'run-1': {
      id: 'run-1',
      taskId: 'task-1',
      listKey: 'implementation',
      ancestry: [],
      stage: 'verify',
      status: 'running',
      gates: { review: 'passed', qa: 'pending' },
    },
    'run-2': {
      id: 'run-2',
      taskId: 'task-2',
      listKey: 'implementation',
      ancestry: [],
      stage: 'code',
      status: 'running',
      gates: {},
    },
  };

  test('reads each task’s own verdicts', () => {
    const view = parse({ loopRuns: runs });
    expect(view.taskGates).toEqual([
      {
        taskId: 'task-1',
        stage: 'verify',
        status: 'running',
        gates: [
          { id: 'review', status: 'passed' },
          { id: 'qa', status: 'pending' },
        ],
      },
      { taskId: 'task-2', stage: 'code', status: 'running', gates: [] },
    ]);
  });

  test('shows the verdict against the task and stage it was given for', () => {
    const view = parse({ loopRuns: runs });
    const status = formatSectionLines(view).join('\n');
    // Not "review passed" — task-1 passed review while task-2 is still coding.
    expect(status).toContain('task-1@verify');
    expect(status).not.toContain('task-2@code');
  });
});

describe('formatDetailsLines', () => {
  test('invalid JSON returns null', () => {
    expect(formatDetailsLines('{')).toBeNull();
    expect(formatDetailsLines('[]')).toBeNull();
  });

  test('v1 scalar fields present', () => {
    const lines = formatDetailsLines(makeV1Session({ revision: 5, title: 'My Task' }));
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('schemaVersion: 1'))).toBe(true);
    expect(lines!.some((l) => l.startsWith('revision: 5'))).toBe(true);
    expect(lines!.some((l) => l.startsWith('title: My Task'))).toBe(true);
  });

  test('activeMutation detail shows callID, agent, outputReady', () => {
    const lines = formatDetailsLines(
      makeV1Session({
        activeMutation: { callID: 'call_xyz', agent: 'review', startedAt: '', outputReady: true },
      })
    );
    expect(lines).not.toBeNull();
    expect(
      lines!.some((l) =>
        l.startsWith('activeMutation: callID=call_xyz agent=review outputReady=true')
      )
    ).toBe(true);
  });

  test('tasks summary includes count and active index', () => {
    const tasks = makeTasks(3);
    const lines = formatDetailsLines(makeV1Session({ tasks }));
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('tasks: 3'))).toBe(true);
    expect(lines!.some((l) => l.startsWith('  active=0 committed=0'))).toBe(true);
  });

  test('gates summary shows status per gate', () => {
    const lines = formatDetailsLines(
      makeV1Session({
        gates: [
          { id: 'invariants', status: 'pass' },
          { id: 'review', status: 'pending' },
          { id: 'qa', status: 'running' },
        ],
      })
    );
    expect(lines).not.toBeNull();
    expect(
      lines!.some((l) => l.startsWith('gates: invariants=pass, review=pending, qa=running'))
    ).toBe(true);
  });

  test('changedFiles: counter + top-3 + +X ещё', () => {
    const lines = formatDetailsLines(
      makeV1Session({
        changedFiles: ['file_a.txt', 'file_b.txt', 'file_c.txt', 'file_d.txt'],
      })
    );
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('changedFiles: 4'))).toBe(true);
    const idx = lines!.findIndex((l) => l.startsWith('changedFiles: 4'));
    expect(lines![idx + 4]).toBe('  +1 ещё');
  });

  test('retry budget shows attempts/maximum', () => {
    const lines = formatDetailsLines(
      makeV1Session({
        retryBudgets: { cycles: { attempts: 2, maximum: 3 } },
      })
    );
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('retry.cycles: 2/3'))).toBe(true);
  });

  test('unknown future fields appear at end', () => {
    const lines = formatDetailsLines(makeV1Session({ brandNewField: 'future value' }));
    expect(lines).not.toBeNull();
    const last = lines![lines!.length - 1]!;
    expect(last.startsWith('brandNewField:')).toBe(true);
  });

  test('long values truncated', () => {
    const lines = formatDetailsLines(makeV1Session({ title: 'T'.repeat(200) }));
    expect(lines!.every((l) => l.length <= 100)).toBe(true);
  });

  test('processedEventIds shown as count', () => {
    const lines = formatDetailsLines(makeV1Session({ processedEventIds: ['a', 'b', 'c'] }));
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('processedEventIds: 3'))).toBe(true);
  });
});
