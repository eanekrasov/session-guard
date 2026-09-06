import { describe, expect, test } from 'bun:test';
import {
  canCommit,
  extractBashCommand,
  hasForbiddenGitSubcommand,
  isCommitTaskCommand,
} from '../../src/domain/session-queries.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

function makeSession(overrides: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    schemaVersion: 2,
    sessionId: 'ses_test',
    revision: 1,
    title: '',
    gates: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    activeTaskContexts: [],
    loopRuns: {},
    testStatus: {},
    deliveryPermit: null,
    deliveryReceipt: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    baselineHashes: [],
    changedFiles: [],
    currentStage: 'planning',
    invariantViolations: [],
    profileId: 'test',
    consentedCallIDs: [],
    ...overrides,
  };
}

describe('extractBashCommand', () => {
  test('возвращает строку как есть', () => {
    expect(extractBashCommand('echo hi')).toBe('echo hi');
  });

  test('извлекает command из объекта { command }', () => {
    expect(extractBashCommand({ command: 'ls -la' })).toBe('ls -la');
  });

  test('возвращает fallback для объекта без command', () => {
    expect(extractBashCommand({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  test('возвращает fallback для null — null ?? "" → JSON.stringify("") → ""', () => {
    expect(extractBashCommand(null)).toBe('""');
  });

  test('возвращает fallback для undefined — JSON.stringify("") даёт ""', () => {
    expect(extractBashCommand(undefined)).toBe('""');
  });

  test('возвращает fallback для числа', () => {
    expect(extractBashCommand(42)).toBe('42');
  });
});

describe('hasForbiddenGitSubcommand', () => {
  test('git commit — запрещён', () => {
    expect(hasForbiddenGitSubcommand('git commit -m "msg"')).toBe(true);
  });

  test('git push — запрещён', () => {
    expect(hasForbiddenGitSubcommand('git push origin main')).toBe(true);
  });

  test('git status — разрешён', () => {
    expect(hasForbiddenGitSubcommand('git status')).toBe(false);
  });

  test('git diff — разрешён', () => {
    expect(hasForbiddenGitSubcommand('git diff HEAD')).toBe(false);
  });

  test('git commit после &&', () => {
    expect(hasForbiddenGitSubcommand('npm test && git commit -a')).toBe(true);
  });

  test('git commit после ||', () => {
    expect(hasForbiddenGitSubcommand('false || git push origin')).toBe(true);
  });

  test('git commit после точки с запятой', () => {
    expect(hasForbiddenGitSubcommand('cd foo; git commit')).toBe(true);
  });

  test('не чувствителен к регистру', () => {
    expect(hasForbiddenGitSubcommand('GIT COMMIT -m "msg"')).toBe(true);
    expect(hasForbiddenGitSubcommand('Git Push')).toBe(true);
  });

  test('игнорирует leading/trailing whitespace', () => {
    expect(hasForbiddenGitSubcommand('  git commit  ')).toBe(true);
  });

  test('commit в середине слова не срабатывает', () => {
    expect(hasForbiddenGitSubcommand('echo gitcommitted')).toBe(false);
  });
});

describe('isCommitTaskCommand', () => {
  test('содержит commit-task.ts', () => {
    expect(isCommitTaskCommand('bun run commit-task.ts')).toBe(true);
  });

  test('без commit-task.ts — false', () => {
    expect(isCommitTaskCommand('bun run something.ts')).toBe(false);
  });
});

describe('canCommit', () => {
  test('все гейты passed и все задачи completed → true', () => {
    const session = makeSession({
      gates: [
        { id: 'invariants', status: 'passed' },
        { id: 'review', status: 'passed' },
      ],
      tasks: {
        stage1: [
          { id: 'task-1', status: 'completed' } as never,
        ],
      },
    });
    expect(canCommit(session, ['invariants', 'review'])).toBe(true);
  });

  test('гейт не пройден → false', () => {
    const session = makeSession({
      gates: [
        { id: 'invariants', status: 'passed' },
        { id: 'review', status: 'pending' },
      ],
      tasks: {
        stage1: [
          { id: 'task-1', status: 'completed' } as never,
        ],
      },
    });
    expect(canCommit(session, ['invariants', 'review'])).toBe(false);
  });

  test('гейт отсутствует → false', () => {
    const session = makeSession({
      gates: [],
      tasks: {},
    });
    expect(canCommit(session, ['missing-gate'])).toBe(false);
  });

  test('есть незавершённые задачи → false', () => {
    const session = makeSession({
      gates: [
        { id: 'invariants', status: 'passed' },
      ],
      tasks: {
        stage1: [
          { id: 'task-1', status: 'completed' } as never,
          { id: 'task-2', status: 'running' } as never,
        ],
      },
    });
    expect(canCommit(session, ['invariants'])).toBe(false);
  });

  test('пустой requiredGates — проверяет только задачи', () => {
    const session = makeSession({
      gates: [],
      tasks: {
        stage1: [
          { id: 'task-1', status: 'completed' } as never,
        ],
      },
    });
    expect(canCommit(session, [])).toBe(true);
  });
});

describe('hasForbiddenGitSubcommand — обход через форму команды', () => {
  // Проверка структурная, а не текстовая: одна и та же команда в разных
  // обёртках — это одна и та же команда.
  const forbidden = [
    ['git -C . push', 'глобальная опция с путём'],
    ['git -C /tmp/repo commit -m x', 'то же для commit'],
    ['/usr/bin/git push', 'абсолютный путь к executable'],
    ['./bin/git push', 'относительный путь'],
    ['git -c user.name=Test commit', 'конфиг перед подкомандой'],
    ['git --git-dir=/tmp/x/.git push', 'опция со значением через ='],
    ['git --git-dir /tmp/x/.git push', 'та же опция через пробел'],
    ['git --no-pager push', 'булев флаг'],
    ['git -c a=b -C . --no-pager push', 'всё сразу'],
    ['"git" push', 'executable в кавычках'],
    ['sudo git push', 'обёртка sudo'],
    ['env git push', 'обёртка env'],
    ['GIT_DIR=/tmp/x git push', 'присваивание переменной перед командой'],
    ['echo $(git push)', 'подстановка команды'],
    ['npm test\ngit push', 'вторая строка'],
    ['npm test | git push', 'после пайпа'],
  ] as const;

  for (const [command, why] of forbidden) {
    test(`запрещён: ${command} — ${why}`, () => {
      expect(hasForbiddenGitSubcommand(command)).toBe(true);
    });
  }

  const allowed = [
    ['git -C . status', 'та же форма, но безопасная подкоманда'],
    ['git -c user.name=Test log', 'конфиг с безопасной подкомандой'],
    ['git --version', 'опция без подкоманды вообще'],
    ['git', 'один только git'],
    ['echo "git push"', 'строка, а не команда'],
    ['echo git-push', 'подкоманда как часть другого слова'],
    ['gitk push', 'другая программа, чьё имя начинается с git'],
    ['/usr/bin/legit push', 'имя, оканчивающееся на git'],
    ['git commit-graph write', 'подкоманда, начинающаяся с commit'],
  ] as const;

  for (const [command, why] of allowed) {
    test(`разрешён: ${command} — ${why}`, () => {
      expect(hasForbiddenGitSubcommand(command)).toBe(false);
    });
  }
});

