import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { compileWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';
import { createTask } from '../support/task-factory.ts';

/**
 * What the compiler refuses at load.
 *
 * Every one of these was previously a silence: a guard that read false
 * forever, a verdict recorded against a gate the profile never declared, a
 * retry that spent a counter no one was watching. A defect in the file should
 * stop the workflow when the file is read.
 */

/** What the fixture profile declares, so a stage's `gates:` has a list to be wrong about. */
const DECLARED_GATES = [
  { id: 'invariants', status: 'pending' },
  { id: 'review', status: 'pending' },
  { id: 'qa', status: 'pending' },
];

function schema(
  stages: ResolvedSchema['stages'],
  transitions: ResolvedSchema['transitions'] = []
): ResolvedSchema {
  return { id: 'test', source: 'test.yaml', stages, transitions, gates: DECLARED_GATES };
}

function messages(input: ResolvedSchema): string[] {
  return compileWorkflow(input).errors.map((error) => error.message);
}

/** `<path>: <message>` — the shape the operator is shown. */
function reported(input: ResolvedSchema): string {
  return compileWorkflow(input)
    .errors.map((error) => `${error.path}: ${error.message}`)
    .join('\n');
}

describe('a workflow that cannot run is refused when it is read', () => {
  it('refuses a loop no task can finish', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        transitions: [{ from: 'code', to: 'verify' }],
      },
    });
    expect(messages(input)).toContain(
      'Loop "execution" declares transitions but none of them reaches "done", so no task can ever finish it'
    );
  });

  it('refuses a loop with nothing to run', () => {
    expect(messages(schema({ execution: { loop: 'implementation' } }))).toEqual([
      'Stage "execution" cycles over "implementation" but declares no stages to run',
    ]);
  });

  it('refuses transitions on a stage that has no loop', () => {
    const input = schema({
      planning: { transitions: [{ from: 'a', to: 'b' }] },
    });
    expect(messages(input)).toContain(
      'Stage "planning" declares transitions but no loop to move a task through'
    );
  });

  it('refuses a gate the profile does not declare', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { verify: { gates: ['review', 'security'] } },
      },
    });
    expect(messages(input)).toContain('Gate "security" is not a gate this profile declares');
  });

  it('refuses a gate the profile does not declare on an outer stage too', () => {
    expect(messages(schema({ validation: { gates: ['smoke'] } }))).toContain(
      'Gate "smoke" is not a gate this profile declares'
    );
  });

  it("reports a nested stage's bad gate once, not once per level that can see it", () => {
    // The parent's walk checked each nested stage's gates and then recursed
    // into that stage, which checked them again under the same path. Every
    // such error was reported twice; `toContain` cannot see a duplicate.
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { verify: { gates: ['security'] } },
      },
    });
    const gateErrors = messages(input).filter((message) => message.includes('Gate "security"'));
    expect(gateErrors).toHaveLength(1);
  });

  it('accepts any gate name when the profile declares none', () => {
    // No declaration is not an empty declaration: there is nothing to be wrong
    // about, so the compiler must not invent a list of its own to reject against.
    const undeclared: ResolvedSchema = {
      id: 'test',
      source: 'test.yaml',
      stages: { validation: { gates: ['smoke'] } },
      transitions: [],
    };
    expect(messages(undeclared)).toEqual([]);
  });

  it('refuses a transition to a stage the loop does not have', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        transitions: [{ from: 'verify', to: 'commit' }],
      },
    });
    expect(messages(input)).toContain(
      'Transition verify → commit names "commit", which is not a stage of "execution"'
    );
  });

  it('refuses a retry that spends a budget other than the task’s own', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        transitions: [{ from: 'verify', to: 'code', effects: [{ bumpRetry: 'cycles' }] }],
      },
    });
    expect(messages(input)).toContain(
      'Transition verify → code bumps "cycles"; inside a loop the budget is the task’s own, written as task.id'.replace(
        '’',
        "'"
      )
    );
  });

  it('accepts the shape the shipped workflow uses', () => {
    const input = schema(
      {
        planning: {},
        execution: {
          loop: 'implementation',
          stages: { code: {}, verify: { gates: ['review', 'qa'] } },
          transitions: [
            { from: 'code', to: 'verify' },
            { from: 'verify', to: 'done' },
            { from: 'verify', to: 'code', effects: [{ bumpRetry: 'task.id' }] },
          ],
        },
        validation: { gates: ['review', 'qa'] },
        commit: {},
        done: {},
      },
      [
        { from: 'planning', to: 'execution' },
        { from: 'execution', to: 'validation' },
        { from: 'validation', to: 'commit' },
        { from: 'commit', to: 'done' },
      ]
    );
    expect(messages(input)).toEqual([]);
  });
});

// ─── The refusal reaches the operator ─────────────────────────────────────────

let storeDirectory: string;
let profilesDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/test',
    worktree: '/tmp/test',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

beforeEach(async () => {
  previousStore = process.env.SESSION_GUARD_STORE_DIR;
  previousProfiles = process.env.SESSION_GUARD_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'compile-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'compile-profiles-'));
  process.env.SESSION_GUARD_STORE_DIR = storeDirectory;
  process.env.SESSION_GUARD_PROFILES_DIR = profilesDirectory;

  const profileDirectory = join(profilesDirectory, 'broken');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'broken', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    stages:',
      '      code: {}',
      '      verify:',
      '        gates: [review]',
      '    transitions:',
      // The loop can finish, so the only defect left is the edge below.
      '      - from: verify',
      '        to: done',
      // `commit` is not a stage of this loop.
      '      - from: verify',
      '        to: commit',
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );

  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'broken', 'cycle');
  session.tasks.implementation = [createTask()];
  await store.save(session);
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
  else process.env.SESSION_GUARD_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.SESSION_GUARD_PROFILES_DIR;
  else process.env.SESSION_GUARD_PROFILES_DIR = previousProfiles;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
});

describe('a guard that cannot be parsed is refused at load', () => {
  it('refuses a transition guard that does not parse', () => {
    // The widest hole in the compiler: `session.gates.(((` compiled clean and
    // then read `false` for ever, so the transition simply never fired. The
    // evaluator reported the parse failure at runtime, which is far too late.
    const input = schema({ a: {}, b: {} }, [{ from: 'a', to: 'b', guard: 'session.gates.(((' }]);

    expect(messages(input).join('\n')).toContain('Guard expression does not parse');
  });

  it('refuses an unparseable stage-assignment condition', () => {
    const input: ResolvedSchema = {
      id: 'test',
      source: 'test.yaml',
      stages: { a: {} },
      stageAssignments: [{ id: 'r', priority: 0, condition: '&& ||', result: 'a' }],
    };

    expect(reported(input)).toContain('stageAssignments[0].condition');
  });

  it('refuses an unparseable guard inside a loop', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        entryGuards: ['session.gates.((('],
        transitions: [
          { from: 'code', to: 'verify', guard: '1 +' },
          { from: 'verify', to: 'done' },
        ],
      },
    });

    const joined = reported(input);
    expect(joined).toContain('stages.execution.entryGuards[0]');
    expect(joined).toContain('stages.execution.transitions[0].guard');
  });

  it('accepts the guards the shipped vocabulary actually uses', () => {
    // `done` здесь не про guard-ы: без стадии, из которой не ведёт ни одного
    // ребра, workflow не заканчивается никогда, и компилятор теперь говорит
    // об этом отдельной ошибкой. Пара `a ⇄ b` крутилась бы вечно.
    const input = schema({ a: {}, b: {}, done: {} }, [
      { from: 'a', to: 'b', guard: "session.approved('plan') && !isExhausted('cycles')" },
      {
        from: 'b',
        to: 'a',
        guard: "session.activeOperations.some(o => o.result == 'output_ready')",
      },
      { from: 'b', to: 'done' },
    ]);

    expect(messages(input)).toEqual([]);
  });
});

describe('a key nothing reads is reported, not ignored', () => {
  it('names an unknown schema-level key', () => {
    // ProfileSchemaSchema is `.passthrough()`, which is how android.yaml
    // carried a dead `phases:` block for months while every test stayed green.
    const input = { ...schema({ a: {} }), phases: { PLANNING: {} } } as ResolvedSchema;

    expect(messages(input).join('\n')).toContain('Unknown key "phases"');
  });

  it('names an unknown key on a stage, at its path', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: { agents: ['code'] } as never },
        transitions: [{ from: 'code', to: 'done' }],
      },
    });

    const joined = reported(input);
    expect(joined).toContain('stages.execution.stages.code.agents');
    expect(joined).toContain('Unknown key "agents"');
  });

  it('says nothing about a schema that declares only known keys', () => {
    expect(messages(schema({ a: {}, b: {} }, [{ from: 'a', to: 'b' }]))).toEqual([]);
  });
});

describe('a schema that does not compile stops the work', () => {
  it('refuses the task rather than running a workflow that cannot finish', async () => {
    const hooks = createRuntime(pluginInput());

    let refusal = '';
    try {
      await hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 's1', callID: 'call-1' },
        {
          args: {
            subagent_type: 'code',
            description: '[workflow-task:task-1] work',
            prompt: 'do it',
          },
        }
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    // The refusal must name the defect in the file, not merely fail somewhere.
    expect(refusal, 'a workflow with a transition to nowhere was admitted').toContain(
      'Transition verify → commit names "commit"'
    );
  });
});

describe('a stage declares what it can do, and the compiler checks it can', () => {
  it('refuses a path mask on an action that carries no path', () => {
    // `bash` получает от хоста только `workdir`. Маску записать можно,
    // выполнить нельзя — а поле, которое читается никем, здесь уже дорого
    // обходилось.
    const input = schema({
      commit: { actions: [{ action: 'bash', paths: ['src/**'] }] },
    });
    expect(reported(input)).toContain("'paths' is only meaningful for action 'edit'");
  });

  it('refuses command patterns on an action that does not arrive as a command', () => {
    const input = schema({
      commit: { actions: [{ action: 'edit', commands: ['npm test'] }] },
    });
    expect(reported(input)).toContain("'commands' is only meaningful for action 'bash'");
  });

  it('refuses a delivery marker on anything but bash', () => {
    // Инструмента `commit` не существует — доставка приезжает шелл-командой.
    const input = schema({
      commit: { actions: [{ action: 'edit', paths: ['src/**'], delivers: true }] },
    });
    expect(reported(input)).toContain("'delivers' is only meaningful for action 'bash'");
  });

  it('refuses a delivery that names no command', () => {
    // Иначе весь bash стадии поехал бы мимо жизненного цикла мутации.
    const input = schema({
      commit: { actions: [{ action: 'bash', delivers: true }] },
    });
    expect(reported(input)).toContain("'delivers' needs 'commands'");
  });

  it('accepts a delivery declared as the bash call it actually is', () => {
    const input = schema({
      commit: {
        actions: [{ action: 'bash', commands: ['bun run .*commit-task\\.ts.*'], delivers: true }],
      },
    });
    expect(messages(input)).toEqual([]);
  });

  it('refuses a directory mask that covers nothing inside it', () => {
    // minimatch якорит и путь, и маску: `src/auth` не совпадёт с
    // `src/auth/login.ts`.
    const input = schema({
      code: { actions: [{ action: 'edit', paths: ['src/auth'] }] },
    });
    expect(reported(input)).toContain("Write 'src/auth/**' to cover a directory");
  });

  it('refuses a command pattern that is not a regular expression', () => {
    const input = schema({
      code: { actions: [{ action: 'bash', commands: ['npm ('] }] },
    });
    expect(reported(input)).toContain('does not compile as a regular expression');
  });

  it('parses an action guard at compile time, like every other expression', () => {
    const input = schema({
      commit: { actions: [{ action: 'bash', guard: 'session.gates.(((' }] },
    });
    expect(reported(input)).toContain('Guard expression does not parse');
  });

  it('reaches actions declared on a nested stage', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: { actions: [{ action: 'edit', paths: ['src/auth'] }] } },
      },
    });
    expect(reported(input)).toContain('stages.execution.stages.code.actions[0].paths[0]');
  });

  it('accepts a well-formed declaration', () => {
    const input = schema({
      commit: {
        actions: [
          { action: 'edit', paths: ['src/**'], guard: "session.approved('plan')" },
          { action: 'bash', commands: ['npm test', 'npm run .*'] },
        ],
      },
    });
    expect(messages(input)).toEqual([]);
  });
});

describe('a stage nothing reaches is refused when the schema is read', () => {
  it('refuses an outer stage no transition leads to', () => {
    // Недостижимая стадия — это объявление, которое никогда не исполнится.
    // Особенно дорого с тех пор, как стадия несёт `actions:`: недостижимая
    // `commit` означает workflow, который не может доставить.
    const input = schema(
      { planning: {}, done: {}, commit: { actions: [{ action: 'bash', commands: ['x'] }] } },
      [{ from: 'planning', to: 'done' }]
    );
    expect(reported(input)).toContain("Stage 'commit' is declared but nothing reaches it");
  });

  it('counts a stage named by a stage assignment as reachable', () => {
    // `stageAssignments` назначают стадию выражением, минуя граф.
    const input: ResolvedSchema = {
      ...schema({ planning: {}, audit: {} }, [{ from: 'planning', to: 'planning' }]),
      stageAssignments: [{ id: 'a', priority: 1, condition: 'true', result: 'audit' }],
    };
    expect(messages(input)).toEqual([]);
  });

  it('refuses a nested stage the loop’s own transitions never reach', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, orphan: {} },
        transitions: [{ from: 'code', to: 'done' }],
      },
    });
    expect(reported(input)).toContain("Nested stage 'orphan' is declared but nothing reaches it");
  });

  it('leaves a loop that declares no transitions alone', () => {
    // Такой цикл ходит по порядку объявления (`nextTaskStage`), и достижимы в
    // нём все. Первая версия этой проверки ругалась на них — поймал корпус.
    const input = schema({
      execution: { loop: 'implementation', stages: { dev: {}, review: {}, qa: {} } },
    });
    expect(messages(input)).toEqual([]);
  });
});

/**
 * Конец workflow — объявление, а не ключ.
 *
 * Терминальной считается стадия, из которой автор не провёл ни одного ребра, —
 * тем же способом, каким начальной считается первая объявленная. До этого
 * понятия не было вовсе: «дошли до конца» и «автор забыл ребро» выглядели
 * одинаково — молчанием движка на каждом следующем ходу.
 */
describe('у workflow должен быть конец, и из каждой стадии должен быть к нему путь', () => {
  it('стадия без исходящих рёбер и есть конец', () => {
    const input = schema({ a: {}, done: {} }, [{ from: 'a', to: 'done' }]);
    expect(messages(input)).toEqual([]);
    expect(compileWorkflow(input).workflow.terminalStages).toEqual(['done']);
  });

  it('концов может быть несколько — так устроен и поставляемый base', () => {
    const input = schema({ a: {}, done: {}, failed: {} }, [
      { from: 'a', to: 'done' },
      { from: 'a', to: 'failed' },
    ]);
    expect(messages(input)).toEqual([]);
    expect(compileWorkflow(input).workflow.terminalStages).toEqual(['done', 'failed']);
  });

  it('workflow, который не заканчивается никогда, отвергается', () => {
    const input = schema({ a: {}, b: {} }, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
    expect(reported(input)).toContain('This workflow has no end');
  });

  it('стадия, из которой до конца не добраться, названа по имени', () => {
    // `stuck` достижима, но выхода из неё нет никуда, кроме себя самой.
    const input = schema({ a: {}, stuck: {}, done: {} }, [
      { from: 'a', to: 'stuck' },
      { from: 'a', to: 'done' },
      { from: 'stuck', to: 'stuck' },
    ]);
    const joined = reported(input);
    expect(joined).toContain('stages.stuck');
    expect(joined).toContain('has no way to finish');
  });

  it('при объявленных stageAssignments путь до конца не проверяется', () => {
    // `deriveStage` выбирает стадию по условию, а не по рёбрам, так что уйти
    // можно и оттуда, откуда не ведёт ни одно ребро. Назвать такую стадию
    // тупиком значило бы соврать.
    const input: ResolvedSchema = {
      ...schema({ a: {}, stuck: {}, done: {} }, [
        { from: 'a', to: 'done' },
        { from: 'a', to: 'stuck' },
        { from: 'stuck', to: 'stuck' },
      ]),
      stageAssignments: [{ id: 'main', priority: 1, condition: 'true', result: 'a' }],
    };
    expect(reported(input)).not.toContain('has no way to finish');
  });
});
