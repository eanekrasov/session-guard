import { describe, expect, test } from 'bun:test';
import {
  formatDetailsLines,
  formatIdleLine,
  formatSectionLines,
  parseRuntimeState,
  type IdleReason,
} from '../../src/tui/tui.ts';
import { WorkflowSessionSchema } from '../../src/session/session-schema.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

/**
 * Настоящая сессия, а не её прежняя форма.
 *
 * Фикстура строила `schemaVersion: 1` с полями `runId`, `currentTaskIndex`,
 * `activeMutation`, `commitPermit`, `processedEventIds`, `tasks` массивом — ни
 * одного из них у сегодняшней схемы нет. Тесты были зелены против формы,
 * которую продакшен не производит, и держали живой толерантность парсера к
 * ней. Схема сама раздаёт умолчания, так что переопределять нужно только то,
 * о чём тест.
 */
function makeSession(overrides: Record<string, unknown> = {}): WorkflowSession {
  return WorkflowSessionSchema.parse({
    sessionId: 'ses_root',
    profileId: 'base',
    schemaId: 'state-machine',
    revision: 1,
    updatedAt: '2026-08-23T00:00:00.000Z',
    gates: [
      { id: 'review', status: 'pending' },
      { id: 'qa', status: 'pending' },
    ],
    retryBudgets: { cycles: { attempts: 0, maximum: 3 } },
    title: 'Test Task',
    ...overrides,
  });
}

/** Список задач под ключом цикла — так их держит сессия. */
function makeTasks(count: number): Record<string, unknown[]> {
  return {
    implementation: Array.from({ length: count }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      status: index === 0 ? 'running' : 'pending',
      branch: `feature/task-${index}`,
    })),
  };
}

describe('parseRuntimeState', () => {
  // Отказы `parse_error`, `invalid_structure`, `unknown_schema` и
  // `missing_session_id` больше не существуют: сюда приходит разобранная
  // схемой сессия, и на всё перечисленное `readSession` отвечает `null`
  // раньше. Остался один настоящий исход — стадии нет.

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

  // The fallback that read planApproved / commitPermit / deliveryReceipt is
  // gone: none of those fields is in the session schema, and `currentStage`
  // carries a schema default, so the branch was unreachable. A session without
  // a stage is a session the TUI cannot place.
  // Тест про откат к `planApproved` / `commitPermit` / `deliveryReceipt` удалён
  // вместе с самим откатом: этих полей у схемы нет, она их срезает, а стадию
  // всегда несёт `currentStage`.

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
    const r = parseRuntimeState(makeSession({ currentStage: 'commit', tasks: makeTasks(1) }));
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

  test('completedTasks считается по статусу completed', () => {
    // `committed` статусом задачи не является и не являлся: в `TASK_STATUS`
    // его нет, так что прежняя проверка не могла сработать никогда.
    const tasks = makeTasks(3);
    (tasks.implementation[1] as Record<string, unknown>).status = 'completed';
    const r = parseRuntimeState(makeSession({ currentStage: 'code', tasks }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.completedTasks).toBe(1);
  });

  test('active operations are read from activeOperations, and there may be several', () => {
    // A verifier stage runs review and qa at once, so a single `activeMutation`
    // could not describe the session even when the field still existed.
    const r = parseRuntimeState(
      makeSession({
        currentStage: 'execution',
        activeOperations: {
          'call-review': {
            callId: 'call-review',
            runId: 'run-1',
            taskId: 'task-1',
            agent: 'review',
            status: 'running',
            startedAt: '2026-08-23T00:00:00.000Z',
            result: 'output_ready',
          },
          'call-qa': {
            callId: 'call-qa',
            runId: 'run-1',
            taskId: 'task-1',
            agent: 'qa',
            status: 'running',
            startedAt: '2026-08-23T00:00:00.000Z',
          },
        },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.activeOperations).toHaveLength(2);
    const review = r.value.activeOperations.find((o) => o.agent === 'review');
    expect(review?.callId).toBe('call-review');
    expect(review?.taskId).toBe('task-1');
    expect(review?.outputReady).toBe(true);
    expect(r.value.activeOperations.find((o) => o.agent === 'qa')?.outputReady).toBe(false);
  });

  test('neighbours are the stages around the current one, for every stage of the chain', () => {
    // The chain listed code / review / qa until the stage model moved them, so
    // `indexOf` missed on every real stage and `nextStage` was STAGES[0] —
    // the sidebar said the stage after `execution` was `planning`.
    const expected: Array<[string, string | null, string | null]> = [
      ['planning', null, 'tasks_ready'],
      ['tasks_ready', 'planning', 'execution'],
      ['execution', 'tasks_ready', 'validation'],
      ['validation', 'execution', 'commit'],
      ['commit', 'validation', 'done'],
      ['done', 'commit', 'failed'],
    ];
    for (const [stage, previous, next] of expected) {
      const r = parseRuntimeState(makeSession({ currentStage: stage }));
      expect(r.ok, stage).toBe(true);
      if (!r.ok) continue;
      expect(r.value.prevStage, `prev of ${stage}`).toBe(previous);
      expect(r.value.nextStage, `next of ${stage}`).toBe(next);
    }
  });

  test('a stage the chain does not know has no neighbours to offer', () => {
    // A profile may name its stages anything; guessing a neighbour for one the
    // chain has never heard of is how `nextStage: planning` got shown.
    const r = parseRuntimeState(makeSession({ currentStage: 'triage' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.prevStage).toBeNull();
    expect(r.value.nextStage).toBeNull();
  });

  test('a session holding no open call reports none', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'planning', activeOperations: {} }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.activeOperations).toEqual([]);
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
    const r = parseRuntimeState(makeSession({ currentStage: 'code', ...overrides }));
    if (r.ok === false) throw new Error(`parse failed: ${r.reason}`);
    return r.value;
  }

  test('contains stage name in first line', () => {
    const view = parse({
      approvals: [{ type: 'plan', callId: 'call_1', status: 'granted', evidence: 'sha256:abc' }],
      tasks: makeTasks(2),
    });
    const lines = formatSectionLines(view);
    expect(lines[0]).toContain('code');
    expect(lines[0]).toContain('▶');
    expect(lines[0]).toContain('✕');
  });

  test('planning shown with prevStage=· nextStage=tasks_ready (compact at 37)', () => {
    const r = parseRuntimeState(makeSession({ currentStage: 'planning' }));
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
        startedAt: '2026-08-23T00:00:00.000Z',
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
      tasks: makeTasks(1),
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
      makeSession({
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
    const r = parseRuntimeState(makeSession({ currentStage: 'execution', ...overrides }));
    if (r.ok === false) throw new Error(`parse failed: ${r.reason}`);
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
        checks: undefined,
      },
      { taskId: 'task-2', stage: 'code', status: 'running', gates: [], checks: undefined },
    ]);
  });

  test('shows a task held by the engine’s own verdict, which carries no gates', () => {
    // Задача, застрявшая в `code` из-за `checks: failed`, гейтов не имеет
    // вовсе. Раньше её строка пропускалась, и оператор не видел ни задачи, ни
    // причины — только то, что ничего не движется.
    const view = parse({
      loopRuns: {
        'run-1': {
          id: 'run-1',
          taskId: 'task-1',
          listKey: 'implementation',
          ancestry: [],
          stage: 'code',
          status: 'running',
          gates: {},
          checks: 'failed',
        },
      },
    });
    expect(view.taskGates[0]?.checks).toBe('failed');
    expect(formatSectionLines(view).join('\n')).toContain('task-1@code ✗checks');
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
  // Разбора текста здесь больше нет: приходит разобранная схемой сессия, и
  // отдавать `null` не на что.

  test('скалярные поля сессии выводятся построчно', () => {
    const lines = formatDetailsLines(makeSession({ revision: 5, title: 'My Task' }));
    expect(lines.some((l) => l.startsWith('sessionId: ses_root'))).toBe(true);
    expect(lines.some((l) => l.startsWith('schemaVersion: 2'))).toBe(true);
    expect(lines.some((l) => l.startsWith('revision: 5'))).toBe(true);
    expect(lines.some((l) => l.startsWith('title: My Task'))).toBe(true);
  });

  test('one detail line per open call', () => {
    const lines = formatDetailsLines(
      makeSession({
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
    const tasks = makeTasks(3);
    const lines = formatDetailsLines(makeSession({ tasks }));
    expect(lines).not.toBeNull();
    expect(lines.some((l) => l.startsWith('tasks: 3'))).toBe(true);
    // `active` и `committed` статусами задачи не являются: в `TASK_STATUS`
    // их нет, и обе цифры всегда были нулями.
    expect(lines.some((l) => l.startsWith('  running=1 completed=0'))).toBe(true);
  });

  test('gates summary shows status per gate', () => {
    const lines = formatDetailsLines(
      makeSession({
        gates: [
          { id: 'invariants', status: 'passed' },
          { id: 'review', status: 'pending' },
          { id: 'qa', status: 'running' },
        ],
      })
    );
    expect(lines).not.toBeNull();
    expect(
      lines.some((l) => l.startsWith('gates: invariants=passed, review=pending, qa=running'))
    ).toBe(true);
  });

  test('changedFiles: counter + top-3 + +X ещё', () => {
    const lines = formatDetailsLines(
      makeSession({
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
      makeSession({
        retryBudgets: { cycles: { attempts: 2, maximum: 3 } },
      })
    );
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.startsWith('retry.cycles: 2/3'))).toBe(true);
  });

  test('поля схемы, не названные явно, всё равно попадают в дамп', () => {
    // Неизвестных полей у сессии больше не бывает — схема их срезает, — но
    // названы построчно не все её поля, и остальные должен подобрать хвост.
    const lines = formatDetailsLines(makeSession({ deliveryReceipt: 'a'.repeat(40) }));
    expect(lines.some((l) => l.startsWith('deliveryReceipt:'))).toBe(true);
  });

  test('long values truncated', () => {
    const lines = formatDetailsLines(makeSession({ title: 'T'.repeat(200) }));
    expect(lines!.every((l) => l.length <= 100)).toBe(true);
  });
});
