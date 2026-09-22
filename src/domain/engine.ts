import { type GuardEvaluationContext, GuardEvaluator } from '../schema/guard-evaluator.ts';
import type { TaskStatus, WorkflowSession } from '../session/session-schema.ts';
import type { StageAssignmentRule, StageDef, TransitionDef } from '../schema/types.ts';
import { nestedStages } from '../schema/types.ts';
import type { SessionFacts } from './session-facts.ts';
import { toSessionFacts } from './session-facts.ts';
import { bumpRetry } from '../session/helpers.ts';
import { approve } from './approvals.ts';
import { initialStageOf } from '../schema/compile-workflow.ts';

// ─── Domain-specific type aliases ──────────────────────────────────────────────

export type StageId = string;
export type { GateStatus, ApprovalStatus, TaskStatus } from '../session/session-schema.ts';

// ─── Value interfaces ─────────────────────────────────────────────────────────

export interface StageTransitionResult {
  allowed: boolean;
  reason?: string;
  nextStage?: StageId;
}

export interface WorkflowResult {
  gate: string;
  status: 'pass' | 'fail';
  summary: string;
  evidence: string[];
}

// ─── Dispatch / Consent config ────────────────────────────────────────────────

export interface ConsentConfig {
  required: boolean;
}

export interface DispatchConfig {
  strategy: 'serial' | 'serial_with_overlap' | 'parallel';
  maxConcurrent: number;
  overlapRoles?: string[];
}

// ─── Task-stage-level config ───────────────────────────────────────────────────────

export interface TaskStageConfig {
  allowedAgents?: string[];
  entryGuards?: string[];
  exitGuards?: string[];
}

// ─── Конфиг движка ────────────────────────────────────────────────────────────

export interface EngineConfig {
  stages?: Record<string, StageDef>;
  stageAssignments: StageAssignmentRule[];
  transitions: TransitionDef[];
  /** agents allowed to drive workflow task state (schema-level, last wins) */
  taskControlAgents?: string[];
  /**
   * Агенты, которые этот workflow считает редакторами.
   *
   * Прошли через резолвинг и никто их не читал до сих пор, поэтому стадия не
   * могла сказать, мутирует ли она. Стадия, чей ростер допускает редактора —
   * стадия, где происходит работа; та, чей ростер не допускает никого — стадия
   * верификации.
   */
  editingAgents?: string[];
}

function consentType(consent: string | { type?: string }): string {
  return typeof consent === 'string' ? consent : (consent.type ?? '');
}

// ─── Transition validation result ──────────────────────────────────────────────

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
  to?: string;
  guard?: string | null;
}

// ─── Inlined deriveStage (from derive-stage.ts) ────────────────────────────────

import type { GuardEvaluationSession } from './session-facts.ts';

function deriveDefaultEvaluateGuard(expr: string, facts: SessionFacts): boolean {
  return new GuardEvaluator(facts as GuardEvaluationSession).evaluate(expr);
}

/**
 * Контекст, против которого оценивается каждый гард.
 *
 * Одна нормализация для всех. Гард, читающий `session.gates.review`,
 * должен означать одно и то же на любом уровне: внешние переходы получали
 * нормализованные факты, где гейты — мапа, а внутренние — сырую сессию,
 * где гейты — массив записей — так что то же выражение читало статус снаружи
 * цикла и `undefined` внутри, молча и навсегда.
 *
 * `task` — факты задачи, которую двигают, присутствует только внутри цикла.
 */
export function toGuardContext(
  session: WorkflowSession,
  task?: Record<string, unknown>
): SessionFacts & { task?: Record<string, unknown> } {
  const facts = toSessionFacts(session);
  return Object.assign(facts, {
    tasks: session.tasks ?? {},
    loopRuns: session.loopRuns ?? {},
    pendingDecisions: session.pendingDecisions ?? [],
    ...(task ? { task } : {}),
  });
}

/**
 * В какой стадии сессия, по правилам назначения её workflow.
 *
 * Оба фоллбека раньше были литералом `'PLANNING'`. ID стадий везде в профиле
 * в нижнем регистре, поэтому это значение не матчило ни одну стадию ни в одном
 * workflow: `getStages()['PLANNING']` — `undefined`, допуск задачи отказывал
 * с "does not declare an executable task loop", а `checkTransition`
 * сообщал о нелегальном переходе, называя стадию, которой нет. Оно падало
 * закрыто, но каждое сообщение об этом лгало.
 *
 * Стадию, которую никто не выбрал, не покидали. Когда ни одно правило не
 * сработало — потому что их нет, или потому что ни одно не матчилось — ответ
 * это стадия, в которой сессия уже находится, единственная стадия, которой мы
 * знаем, что у workflow есть.
 */
export function deriveStageFn(
  facts: SessionFacts,
  rules: StageAssignmentRule[],
  evaluateGuard?: (expr: string) => boolean
): string {
  // `SessionFacts` types this optional, but every real session carries it —
  // `currentStage` is a required string on the session and is written by
  // `workflow-create` from the compiled workflow's own first stage.
  const currentStage = facts.currentStage ?? '';
  if (rules.length === 0) return currentStage;

  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  const guardFn = evaluateGuard ?? ((expr: string) => deriveDefaultEvaluateGuard(expr, facts));
  for (const rule of sorted) {
    if (guardFn(rule.condition)) return rule.result;
  }
  return currentStage;
}

// ─── Inlined checkTransition (from validate-transition.ts) ───────────────────

/**
 * Проверить, может ли *любое* ребро между двумя стадиями быть взято.
 *
 * Схема может объявлять несколько ребер между одной и той же парой,
 * отличающихся гардами (например, одно требует gates == 'passed', а другое
 * проверяет 'failed'). Раньше возвращался результат только *первого*
 * подходящего ребра, молча пропуская альтернативы — так что схема с
 *
 *   { from: 'a', to: 'b', guard: 'false' },
 *   { from: 'a', to: 'b', guard: 'condition == true' },
 *
 * никогда не доходила до второго ребра, потому что `find()` всегда возвращал
 * первое.
 *
 * Теперь оно оценивает каждое кандидат-ребро from→to в порядке схемы и
 * возвращает первое, что прошло. Если ни одно не прошло, возвращает первый
 * фейл с причиной, в которой перечислены все оценённые гарды для диагностики.
 */
export function checkTransition(
  from: string,
  to: string,
  transitions: TransitionDef[],
  session?: SessionFacts,
  evaluateGuard?: (expr: string) => boolean
): TransitionCheck {
  const candidates = transitions.filter((t) => t.from === from && t.to === to);

  if (candidates.length === 0) {
    return { allowed: false, reason: `Illegal stage transition: ${from} → ${to}` };
  }

  let firstFailure: TransitionCheck | undefined;
  for (const transition of candidates) {
    const result = evaluateTransition(transition, session, evaluateGuard);
    if (result.allowed) return result;
    firstFailure ??= result;
  }

  return firstFailure!;
}

/** Можно ли взять именно это ребро. */
export function evaluateTransition(
  transition: TransitionDef,
  session?: SessionFacts,
  evaluateGuard?: (expr: string) => boolean
): TransitionCheck {
  const from = transition.from;
  const to = transition.to;
  const guard = transition.guard;

  // Без сессии нечего оценивать условие против, а неоценённое условие не
  // удовлетворено. Каждый условный блок ниже раньше писали `if (… && session)`,
  // так что вызывающий код без сессии получал ответ, что каждое условное ребро
  // разрешено. Ребро, не несущее никакого условия, всё ещё разрешено: этот
  // ответ о форме графа и не требует сессии.
  const conditions: string[] = [];
  if (guard && guard.trim() !== '') conditions.push('a guard');
  if (transition.consent) conditions.push('consent');
  if (transition.onFailure === 'retry') conditions.push('onFailure=retry');
  if (conditions.length > 0 && !session) {
    return {
      allowed: false,
      reason: `Transition ${from} → ${to} carries ${conditions.join(' and ')} and cannot be checked without a session`,
      guard,
    };
  }

  if (guard && guard.trim() !== '' && session) {
    const passed = evaluateGuard
      ? evaluateGuard(guard)
      : new GuardEvaluator(session as GuardEvaluationSession).evaluate(guard);
    if (!passed) {
      return {
        allowed: false,
        reason: `Transition guard failed for ${from} → ${to}: ${guard}`,
        guard,
      };
    }
  }

  if (transition.consent && session && !session.approved(consentType(transition.consent))) {
    return {
      allowed: false,
      reason: `Transition ${from} → ${to} requires approval for ${consentType(transition.consent)}`,
      guard,
    };
  }

  // `onFailure: retry` — это пара клауз, которые `base.yaml` пишет руками —
  // `!isExhausted(key)` на ребре, что уходит по кругу, и эффект `bumpRetry`
  // на нём — сказано один раз. Бюджет — это стадия, которую ретраят, поэтому
  // ключ — `from`; трата попытки происходит там, где ребро берётся.
  //
  // `terminal` половине ничего не нужно: как только ребро ретрая закрывается,
  // первое ещё открытое ребро из стадии — то, что уводит от неё.
  if (transition.onFailure === 'retry' && session?.isExhausted(from)) {
    return {
      allowed: false,
      reason: `Transition ${from} → ${to} (onFailure=retry) has spent the retry budget for ${from}`,
      guard,
    };
  }

  return { allowed: true, to: transition.to, guard };
}

// ─── EvaluateGuardFn type ──────────────────────────────────────────────────────

export type EvaluateGuardFn = (
  expression: string,
  session: GuardEvaluationSession,
  guards: Record<string, (...args: unknown[]) => unknown>,
  evaluationContext?: GuardEvaluationContext
) => boolean;

// ─── SessionGuardEngine ────────────────────────────────────────────────────────

export class SessionGuardEngine {
  private readonly config: EngineConfig;
  private readonly evaluateGuardFn: EvaluateGuardFn;

  constructor(config: EngineConfig, evaluateGuardFn?: EvaluateGuardFn) {
    this.config = {
      ...config,
      stageAssignments: config.stageAssignments ?? [],
      transitions: config.transitions ?? [],
    };
    this.evaluateGuardFn = evaluateGuardFn ?? defaultEvaluateGuard;
  }

  /**
   * Оценить выражение гарда против контекста сессии.
   * Единая точка изменения для логики оценки гардов (совместимость DSL и т.д.).
   */
  evaluateGuard(
    expression: string,
    session: GuardEvaluationSession,
    evaluationContext: GuardEvaluationContext = {}
  ): boolean {
    return this.evaluateGuardFn(
      expression,
      session,
      {} as Record<string, (...args: unknown[]) => unknown>,
      evaluationContext
    );
  }

  /**
   * Вывести текущую стадию из WorkflowSession.
   */
  deriveStage(session: WorkflowSession, evaluationContext: GuardEvaluationContext = {}): StageId {
    const facts = toSessionFacts(session);
    const guardContext = toGuardContext(session);
    return deriveStageFn(facts, this.config.stageAssignments, (expr) =>
      this.evaluateGuard(expr, guardContext, evaluationContext)
    );
  }

  /**
   * Валидировать переход стадии. Оценивает каждое кандидат-ребро from→to в
   * порядке схемы — схема может объявлять несколько ребер между одной парой
   * с разными гардами. Возвращает первое, что прошло, или первый фейл.
   *
   * Конвертирует сессию в SessionFacts внутри, если сессия передана.
   */
  checkTransition(
    from: StageId,
    to: StageId,
    session?: WorkflowSession,
    evaluationContext: GuardEvaluationContext = {}
  ): TransitionCheck {
    const facts = session ? toGuardContext(session) : undefined;
    return checkTransition(
      from,
      to,
      this.config.transitions,
      facts,
      facts ? (expr) => this.evaluateGuard(expr, facts, evaluationContext) : undefined
    );
  }

  /**
   * Агентам разрешено драйвить состояние задач workflow.
   *
   * Статус задачи — это то, что читают `allTasksCompleted()` и
   * `hasPendingTasks()`, поэтому агент, который может его сетить, может
   * закрыть свою стадию. Контроль поэтому у оркестратора, если схема не говорит
   * иначе.
   */
  /**
   * Стадии workflow, смерженные во всех схемах, в которые резолвится профиль.
   *
   * Единый источник для поиска стадий: профиль резолвится в несколько файлов
   * схем, и поиск их по одному даёт тот, которого порядок поиска случайно
   * достиг — гард родителя здесь, ростер ребёнка там.
   */
  getStages(): Record<string, StageDef> {
    return this.config.stages ?? {};
  }

  /**
   * Стадия, в которой сессия стартует — первая, которую объявляет workflow.
   *
   * `compileWorkflow` это вычислил, а никто не читал, поэтому создание сессии
   * писало литерал `'planning'`. Схема, объявляющая `start → done`, затем
   * создавала сессию, припаркованную в стадии, которой она не объявляет: нет
   * исходящего ребра, нет допуска, и нет ошибки, чтобы сказать почему.
   * `deriveStage` отвечает на другой вопрос — где существующая сессия сейчас.
   */
  getInitialStage(): string {
    return initialStageOf(this.config.stages);
  }

  /**
   * Стадия, которая циклится над именованным списком задач, если есть.
   *
   * Лупы гнездятся, а это искало только верхний уровень — поэтому допуск мог
   * запустить задачу вложенного лупа, пока обработчик результата, спрашивая
   * то же самое здесь, получал ничего: задача сообщала об успехе и оставалась
   * `running` за `no loop stage resolved`.
   *
   * `$currentTask.id` раньше матчил любой ключ. Оно называет список задачи,
   * над которой работают, чей ключ — id этой задачи, так что матчит один.
   */
  /**
   * Заканчивается ли workflow этой стадией.
   *
   * Конец определяется объявлением: стадия есть в схеме, и ни одно ребро из
   * неё не ведёт. Того же мнения держится `compileWorkflow`
   * (`terminalStagesOf`), и оно там же проверяется — схема без единого конца
   * или со стадией, из которой до конца не добраться, не компилируется.
   */
  isTerminalStage(stageId: string): boolean {
    if (!this.getStages()[stageId]) return false;
    return !this.config.transitions.some((transition) => transition.from === stageId);
  }

  getLoopStage(listKey: string): StageDef | null {
    const owns = (stage: StageDef): boolean =>
      stage.loop === listKey || (stage.loop === '$currentTask.id' && /^task-[0-9]+$/.test(listKey));

    const search = (stages: StageDef[]): StageDef | null => {
      for (const stage of stages) {
        if (owns(stage)) return stage;
        const nested = search(nestedStages(stage));
        if (nested) return nested;
      }
      return null;
    };

    return search(Object.values(this.getStages()));
  }

  getTaskControlAgents(): string[] {
    return this.config.taskControlAgents ?? ['orchestrator'];
  }

  /** Агенты, которых этот workflow объявляет редакторами. */
  getEditingAgents(): string[] {
    return this.config.editingAgents ?? [];
  }

  /**
   * Попробовать применить первое подходящее исходящее переход из текущей стадии.
   *
   * Сканирует ВСЕ переходы из текущей выведенной стадии,
   * валидирует гарды и требования гейтов каждого, и применяет первый
   * прошедший, выставляя `session.currentStage`.
   *
   * Возвращает результат применённого перехода (если был).
   * Возвращает `{ allowed: false, applied: false }`, когда ни один исходящий
   * переход не подошёл.
   */
  tryApplyTransitions(
    session: WorkflowSession,
    evaluationContext: GuardEvaluationContext = {}
  ): TransitionCheck & { applied?: boolean; from?: string } {
    const currentStage = this.deriveStage(session, evaluationContext);
    const facts = toGuardContext(session);

    const outgoing = this.config.transitions.filter((t) => t.from === currentStage);
    if (outgoing.length === 0) {
      // Конец workflow, а не поломка. Прежний текст — «No outgoing transitions
      // from X» — описывал устройство графа и одинаково звучал для честно
      // завершённой сессии и для стадии, из которой автор забыл ребро. Второе
      // теперь не доживает до рантайма: `validateTermination` не пускает такую
      // схему, — так что здесь остался ровно один смысл, и он назван.
      return {
        allowed: false,
        reason: `Workflow finished: '${currentStage}' is where it ends`,
        applied: false,
      };
    }

    const currentStageDef = this.getStages()[currentStage];

    for (const transition of outgoing) {
      const targetStageDef = this.getStages()[transition.to];
      const blockedExitGuard = (currentStageDef?.exitGuards ?? []).find(
        (guard) => !this.evaluateGuard(guard, facts, evaluationContext)
      );
      if (blockedExitGuard !== undefined) {
        continue;
      }
      const blockedEntryGuard = (targetStageDef?.entryGuards ?? []).find(
        (guard) => !this.evaluateGuard(guard, facts, evaluationContext)
      );
      if (blockedEntryGuard !== undefined) {
        continue;
      }

      // Кандидат в руках, а не снова ищённый по эндпоинтам: схема может
      // объявлять несколько ребер между теми же двумя стадиями, и повторный
      // поиск по `from`/`to` судит первый из них каждый раз — так что
      // альтернативное ребро, чей гард выполняется, никогда не достигается.
      const result = evaluateTransition(transition, facts, (expr) =>
        this.evaluateGuard(expr, facts, evaluationContext)
      );

      if (result.allowed) {
        if (transition.onFailure === 'retry') {
          bumpRetry(session, currentStage);
          const maximum = currentStageDef?.retryBudget?.maximum;
          if (maximum !== undefined) session.retryBudgets[currentStage]!.maximum = maximum;
        }
        for (const effect of transition.effects ?? []) {
          if (effect.bumpRetry) {
            bumpRetry(session, effect.bumpRetry);
            if (effect.maxAttempts !== undefined) {
              session.retryBudgets[effect.bumpRetry].maximum = effect.maxAttempts;
            }
          }
          if (effect.approve) {
            approve(
              session,
              effect.approve,
              '',
              `transition:${currentStage}->${transition.to}`,
              new Date().toISOString()
            );
          }
        }
        const leftStage = currentStage;
        session.currentStage = transition.to;
        // Вердикт ядра о ходе принадлежит стадии, на которой этот ход был
        // сделан. Унесённый на следующую, он утверждал бы о её работе то,
        // чего никто не проверял.
        session.checks = undefined;
        this.resetLoopTasksOnEntry(session, transition.to);
        return { ...result, applied: true, from: leftStage };
      }
    }

    return {
      allowed: false,
      applied: false,
      reason: 'No matching outgoing transition from ' + currentStage,
    };
  }

  /**
   * Стадия-луп представляет новый раунд работы при повторном входе. Без
   * сброса её списка задач отклонённая внешняя валидация повторно входит в
   * выполнение с завершёнными задачами; следующее чтение сразу удовлетворяет
   * allTasksCompleted() и сжирает ещё один ретрай без какой-либо работы.
   */
  private resetLoopTasksOnEntry(session: WorkflowSession, stageId: string): void {
    const loop = this.getStages()[stageId]?.loop;
    if (!loop || loop === '$currentTask.id') return;

    for (const task of session.tasks[loop] ?? []) {
      task.status = 'pending';
    }
  }
}

// ─── Default guard evaluator ───────────────────────────────────────────────────

function defaultEvaluateGuard(
  expression: string,
  session: GuardEvaluationSession,
  guards: Record<string, (...args: unknown[]) => unknown>,
  evaluationContext: GuardEvaluationContext = {}
): boolean {
  const evaluator = new GuardEvaluator(
    session,
    guards as Record<string, Function>,
    evaluationContext
  );
  return evaluator.evaluate(expression);
}
