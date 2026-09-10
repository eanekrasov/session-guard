import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { resolveConfig } from '../../src/public-api.ts';
import { schemaToEngineConfig, selectSchema } from '../../src/app/mutation-orchestrator.ts';
import { SessionGuardEngine, toGuardContext } from '../../src/domain/engine.ts';
import { admitAction, commandMatches } from '../../src/domain/action-admission.ts';
import { approve } from '../../src/domain/approvals.ts';
import type { ActionEntry } from '../../src/schema/profile-schema.ts';
import { createSession } from '../../src/session/session-store.ts';
import { setGateStatus } from '../../src/session/helpers.ts';
import { createTask } from '../support/task-factory.ts';
import type { StageDef } from '../../src/schema/types.ts';

const PROFILES_DIR = path.resolve(import.meta.dirname, '../../profiles');

async function engineConfigFor(profileId: string) {
  const profile = await resolveConfig(profileId, PROFILES_DIR);
  return {
    profile,
    config: schemaToEngineConfig(selectSchema(profileId, profile.schemas, undefined)),
  };
}

function stage(config: { stages?: Record<string, StageDef> }, id: string): StageDef | undefined {
  return config.stages?.[id];
}

describe('shipped profiles', () => {
  it.each(['base', 'harness', 'android'])('%s resolves into a usable engine config', async (id) => {
    const { config } = await engineConfigFor(id);
    expect(Object.keys(config.stages ?? {})).toContain('commit');
    expect(config.transitions.length).toBeGreaterThan(0);
  });

  it.each(['base', 'harness', 'android'])(
    '%s inherits the base transition set intact',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const edges = config.transitions.map((t) => `${t.from}→${t.to}`);
      expect(edges).toEqual(
        expect.arrayContaining([
          'planning→tasks_ready',
          'tasks_ready→execution',
          'execution→validation',
          'validation→commit',
          'validation→execution',
          'validation→failed',
          'commit→done',
        ])
      );
    }
  );

  it.each(['base', 'harness', 'android'])(
    '%s runs code and verify inside the execution loop',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const execution = config.stages?.execution;
      expect(execution?.loop, 'execution does not cycle over a task list').toBe('implementation');

      const nested = Object.keys(execution?.stages ?? {});
      expect(nested).toEqual(['code', 'verify']);

      // The verifier stage declares what it waits for; both agents report into it.
      expect(execution?.stages?.verify?.gates).toEqual(['review', 'qa']);

      const inner = (execution?.transitions ?? []).map((t) => `${t.from}→${t.to}`);
      expect(inner).toEqual(expect.arrayContaining(['code→verify', 'verify→code']));

      // A failed task spends its own budget, never a session-wide counter.
      const backToCode = execution?.transitions?.find(
        (t) => t.from === 'verify' && t.to === 'code'
      );
      expect(backToCode?.effects?.[0]?.bumpRetry).toBe('task.id');
    }
  );

  it.each(['base', 'harness', 'android'])(
    '%s advances out of commit on the receipt, never the permit',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const commitDone = config.transitions.find((t) => t.from === 'commit' && t.to === 'done');
      expect(commitDone?.guard).toBe('session.deliveryReceipt != null');
    }
  );

  it.each(['base', 'harness', 'android'])(
    '%s resolves agent rosters to names the host will report',
    async (id) => {
      const { config } = await engineConfigFor(id);
      // Synced agents register as `<profileId>/<name>`, so resolution qualifies
      // every roster entry. Bare names left here would never match a dispatch.
      for (const [stageId, def] of Object.entries(config.stages ?? {})) {
        for (const agent of def.allowedAgents ?? []) {
          expect(agent, `stage "${stageId}" of profile "${id}"`).toContain('/');
        }
        for (const [nestedId, nested] of Object.entries(def.stages ?? {})) {
          for (const agent of nested.allowedAgents ?? []) {
            expect(agent, `stage "${nestedId}" of profile "${id}"`).toContain('/');
          }
        }
      }
    }
  );

  it('harness and android stay distinguishable by their editing roles', async () => {
    const harness = await engineConfigFor('harness');
    const android = await engineConfigFor('android');
    expect(harness.profile.schemas.some((s) => s.editingAgents?.includes('harness'))).toBe(true);
    expect(android.profile.schemas.some((s) => s.editingAgents?.includes('figma'))).toBe(true);
  });

  it.each(['base', 'harness', 'android'])('%s compiles without errors', async (id) => {
    const { compileWorkflow } = await import('../../src/schema/compile-workflow.ts');
    const { config, profile } = await engineConfigFor(id);
    const { errors } = compileWorkflow({
      id: profile.metadata.id,
      source: profile.metadata.id,
      stages: config.stages,
      transitions: config.transitions,
      stageAssignments: config.stageAssignments,
    });
    expect(errors, errors.map((e) => `${e.path}: ${e.message}`).join('\n')).toEqual([]);
  });

  it('every stage agent restriction names an agent the profile ships', async () => {
    const { agentIsAllowed } = await import('../../src/app/agent-names.ts');
    for (const id of ['base', 'harness', 'android']) {
      const { profile, config } = await engineConfigFor(id);
      const shipped = profile.metadata.agents;

      // Rosters are compared the way the runtime compares them: a restriction
      // arrives qualified (`android/review`), the manifest lists bare names.
      const check = (stageId: string, def: { allowedAgents?: string[] }): void => {
        for (const agent of def.allowedAgents ?? []) {
          expect(
            agentIsAllowed(agent, shipped, id),
            `profile "${id}" restricts stage "${stageId}" to agent "${agent}", which it does not ship`
          ).toBe(true);
        }
      };

      for (const [stageId, def] of Object.entries(config.stages ?? {})) {
        check(stageId, def);
        for (const [nestedId, nested] of Object.entries(def.stages ?? {})) {
          check(`${stageId}/${nestedId}`, nested);
        }
      }
    }
  });
});

/** Ровно тот вызов, который скиллы диктовали агенту в старом харнессе. */
const COMMIT_CALL = 'bun run .opencode/scripts/commit-task.ts --Message m --Files a.kt';

describe('base carries the former canCommit on the delivering bash entry', () => {
  function sessionInValidation(taskStatus: 'running' | 'completed', profile = 'base') {
    const session = createSession('sp-commit', profile, profile, 'validation');
    session.tasks = { implementation: [createTask({ id: 'task-1', status: taskStatus })] };
    setGateStatus(session, 'review', 'passed');
    setGateStatus(session, 'qa', 'passed');
    return session;
  }

  async function commitActions(profile = 'base'): Promise<ActionEntry[] | undefined> {
    const { config } = await engineConfigFor(profile);
    return config.stages?.commit?.actions;
  }

  async function deliveryEntry(profile = 'base'): Promise<ActionEntry | undefined> {
    return (await commitActions(profile))?.find((entry) => entry.delivers);
  }

  it('declares the condition on the action, not on the edge into commit', async () => {
    const { config } = await engineConfigFor('base');

    // Ребро отвечает за движение и несёт базовый guard, без allTasksCompleted.
    const intoCommit = config.transitions.filter(
      (t) => t.from === 'validation' && t.to === 'commit'
    );
    expect(intoCommit).toHaveLength(1);
    expect(intoCommit[0]?.guard).not.toContain('allTasksCompleted');

    // Авторизует действие.
    // Инструмента `commit` не существует: доставка — это `bash`, помеченный
    // `delivers`.
    const delivery = await deliveryEntry();
    expect(delivery?.action).toBe('bash');
    expect(delivery?.guard).toContain("allTasksCompleted('implementation')");
  });

  it('refuses the commit while a task is still open, even with review and qa passed', async () => {
    const { config } = await engineConfigFor('base');
    const engine = new SessionGuardEngine(config);
    const session = sessionInValidation('running');
    const verdict = admitAction(
      await commitActions(),
      { action: 'bash', command: COMMIT_CALL },
      (expression) => engine.evaluateGuard(expression, toGuardContext(session))
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('allTasksCompleted');
  });

  it('allows the commit once every task is completed', async () => {
    const { config } = await engineConfigFor('base');
    const engine = new SessionGuardEngine(config);
    const session = sessionInValidation('completed');
    const verdict = admitAction(
      await commitActions(),
      { action: 'bash', command: COMMIT_CALL },
      (expression) => engine.evaluateGuard(expression, toGuardContext(session))
    );
    expect(verdict.allowed).toBe(true);
  });

  it.each(['harness', 'android'])('%s inherits the delivery from base', async (id) => {
    // Стадии сливаются по записям: профиль, не переобъявивший `commit`,
    // получает доставку родителя целиком.
    const delivery = await deliveryEntry(id);
    expect(delivery?.commands?.[0]).toContain('commit-task');
    expect(delivery?.guard).toContain("allTasksCompleted('implementation')");

    const { config } = await engineConfigFor(id);
    const engine = new SessionGuardEngine(config);
    const session = sessionInValidation('running', id);
    const verdict = admitAction(
      await commitActions(id),
      { action: 'bash', command: COMMIT_CALL },
      (expression) => engine.evaluateGuard(expression, toGuardContext(session))
    );
    expect(verdict.allowed).toBe(false);
  });

  it('gates editing on the code stage, inside the execution loop', async () => {
    const { config } = await engineConfigFor('android');
    const code = config.stages?.execution?.stages?.code;
    const edit = code?.actions?.find((entry) => entry.action === 'edit');
    expect(edit?.guard).toBe("session.approved('plan')");

    const engine = new SessionGuardEngine(config);
    const session = createSession('sp-android-code', 'android', 'android', 'execution');
    const refused = admitAction(
      code?.actions,
      { action: 'edit', paths: ['app/src/Main.kt'] },
      (expression) => engine.evaluateGuard(expression, toGuardContext(session))
    );
    expect(refused.allowed).toBe(false);

    approve(session, 'plan', 'evidence', 'call-1');
    const allowed = admitAction(
      code?.actions,
      { action: 'edit', paths: ['app/src/Main.kt'] },
      (expression) => engine.evaluateGuard(expression, toGuardContext(session))
    );
    expect(allowed.allowed).toBe(true);
  });
  it('identifies the commit call from the schema, not from the core', async () => {
    const patterns = (await deliveryEntry())?.commands ?? [];
    expect(patterns.length).toBeGreaterThan(0);

    // The schema identifies the delivery command.
    expect(commandMatches(COMMIT_CALL, patterns)).toBe(true);

    // A different command is not delivery unless the schema declares it too.
    const direct = './scripts/commit-task.ts --Message m';
    expect(commandMatches(direct, patterns)).toBe(false);
  });
  it.each(['base', 'harness', 'android'])(
    '%s refuses an edit on `code` until the plan is approved',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const engine = new SessionGuardEngine(config);
      const code = config.stages?.execution?.stages?.code;

      // Каждый профиль обязан нести `edit` в своём списке: `actions` заменяет
      // родительский целиком, и потомок, забывший его повторить, снял бы
      // guard молча.
      const edit = code?.actions?.find((entry) => entry.action === 'edit');
      expect(edit?.guard).toBe("session.approved('plan')");

      const session = createSession(`sp-${id}-code`, id, id, 'execution');
      const request = { action: 'edit' as const, paths: ['src/a.ts'] };
      const evaluate = (expression: string): boolean =>
        engine.evaluateGuard(expression, toGuardContext(session));

      expect(admitAction(code?.actions, request, evaluate).allowed).toBe(false);

      approve(session, 'plan', 'evidence', 'call-1');
      expect(admitAction(code?.actions, request, evaluate).allowed).toBe(true);
    }
  );
  it('every base stage says what it allows, so no refusal is accidental', async () => {
    // До объявления `actions:` отказ на этих стадиях приходил от жизненного
    // цикла мутации — «Cannot resolve a single workflow task run», — то есть
    // по совпадению, а не по правилу, и сообщение говорило о сантехнике.
    const { config } = await engineConfigFor('base');
    const outer = config.stages ?? {};

    for (const id of ['planning', 'tasks_ready', 'validation', 'commit', 'done', 'failed']) {
      expect(outer[id]?.actions, `stage ${id} declares no actions`).toBeDefined();
    }
    expect(outer.execution?.stages?.code?.actions).toBeDefined();

    // Конечные стадии не разрешают ничего: список объявлен и пуст.
    for (const id of ['done', 'failed']) {
      expect(outer[id]?.actions).toEqual([]);
      const verdict = admitAction(
        outer[id]?.actions,
        { action: 'bash', command: 'git status' },
        () => true
      );
      expect(verdict.allowed).toBe(false);
    }

    // Работа разрешена ровно на одной стадии.
    const editable = Object.entries(outer).filter(([, stage]) =>
      stage.actions?.some((entry) => entry.action === 'edit')
    );
    expect(editable.map(([id]) => id)).toEqual([]);
    expect(outer.execution?.stages?.code?.actions?.some((entry) => entry.action === 'edit')).toBe(
      true
    );
  });
  it.each(['base', 'harness', 'android'])(
    '%s declares actions on the outer loop stage too, not only on `code`',
    async (id) => {
      // Действующей стадией внешняя становится, пока не открыт ни один
      // прогон — окно между входом в `execution` и допуском первой задачи.
      // Без объявления здесь правка в этом окне проходила без плана.
      const { config } = await engineConfigFor(id);
      const execution = config.stages?.execution;
      expect(execution?.actions, `${id}: execution declares no actions`).toBeDefined();

      const engine = new SessionGuardEngine(config);
      const session = createSession(`sp-${id}-outer`, id, id, 'execution');
      approve(session, 'plan', 'evidence', 'call-1');
      const verdict = admitAction(
        execution?.actions,
        { action: 'edit', paths: ['src/a.ts'] },
        (expression) => engine.evaluateGuard(expression, toGuardContext(session))
      );
      // Работа идёт во вложенной стадии; на внешней правки не место даже с планом.
      expect(verdict.allowed).toBe(false);
    }
  );
  it.each(['base', 'harness', 'android'])(
    '%s judges the first edit of a task by the stage the run will open on',
    async (id) => {
      // Поймано host-smoke: `beginMutation` открывает прогон ПОСЛЕ допуска
      // действия, поэтому первая правка каждой задачи приходит без открытого
      // прогона. Судить её по внешней стадии цикла нельзя — та про раздачу
      // задач, — иначе допуск и жизненный цикл расходятся, и работа не
      // начинается никогда.
      const { config } = await engineConfigFor(id);
      const outer = config.stages?.execution;
      const first = Object.values(outer?.stages ?? {})[0];

      // Внешняя стадия правок не разрешает…
      expect(outer?.actions?.some((entry) => entry.action === 'edit')).toBeFalsy();
      // …а первая вложенная — разрешает, под утверждённым планом.
      const edit = first?.actions?.find((entry) => entry.action === 'edit');
      expect(edit?.guard).toBe("session.approved('plan')");
    }
  );
});
