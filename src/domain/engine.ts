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

// ─── Engine config ────────────────────────────────────────────────────────────

export interface EngineConfig {
  stages?: Record<string, StageDef>;
  stageAssignments: StageAssignmentRule[];
  transitions: TransitionDef[];
  /** agents allowed to drive workflow task state (schema-level, last wins) */
  taskControlAgents?: string[];
  /**
   * The agents this workflow considers editors.
   *
   * Carried through resolution and read by nobody until now, which is why a
   * stage could not say whether it mutates. A stage whose roster admits an
   * editor is a stage where work happens; one whose roster admits none is a
   * verification stage.
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
 * The context every guard is evaluated against.
 *
 * One normalisation for all of them. A guard reading `session.gates.review`
 * must mean the same thing at any level: outer transitions were handed the
 * normalised facts, where gates are a map, while inner ones were handed the raw
 * session, where gates are an array of records — so the same expression read a
 * status outside the loop and `undefined` inside it, silently and for ever.
 *
 * `task` is the facts of the task being moved, present only inside a loop.
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
 * Which stage a session is in, by its workflow's own assignment rules.
 *
 * Both fallbacks used to be the literal `'PLANNING'`. Stage ids are lowercase
 * everywhere a profile writes them, so that value matched no stage in any
 * workflow: `getStages()['PLANNING']` is `undefined`, task admission refused
 * with "does not declare an executable task loop", and `checkTransition`
 * reported an illegal transition naming a stage that does not exist. It failed
 * closed, but every message about it was a lie.
 *
 * A stage nobody selected has not been left. When no rule applies — because
 * there are none, or because none matched — the answer is the stage the
 * session is already in, which is the only stage we know the workflow has.
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
 * Check whether *any* edge between two stages may be taken.
 *
 * A schema may declare several edges between the same pair, distinguished by
 * their guards (e.g. one that requires gates == 'passed' and another that
 * checks for 'failed'). This used to return the result of only the *first*
 * matching edge, silently skipping alternatives — so a schema with
 *
 *   { from: 'a', to: 'b', guard: 'false' },
 *   { from: 'a', to: 'b', guard: 'condition == true' },
 *
 * would never reach the second edge because `find()` always returned the first.
 *
 * Now it evaluates every candidate edge from→to in schema order and returns
 * the first that passes. If none passes, it returns the first failure with a
 * reason that lists all evaluated guards for diagnostics.
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

/** Whether this exact edge may be taken. */
export function evaluateTransition(
  transition: TransitionDef,
  session?: SessionFacts,
  evaluateGuard?: (expr: string) => boolean
): TransitionCheck {
  const from = transition.from;
  const to = transition.to;
  const guard = transition.guard;

  // Without a session there is nothing to evaluate a condition against, and an
  // unevaluated condition is not a satisfied one. Every conditional clause
  // below used to be written `if (… && session)`, so a caller with no session
  // was told every conditional edge was allowed. An edge that carries no
  // condition at all is still allowed: that answer is about the shape of the
  // graph and needs no session.
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

  // `onFailure: retry` is the pair of clauses `base.yaml` writes by hand —
  // `!isExhausted(key)` on the edge that goes round again, and a `bumpRetry`
  // effect on it — said once. The budget is the stage being retried, so the
  // key is `from`; spending an attempt happens where the edge is taken.
  //
  // The `terminal` half needs nothing: once the retry edge closes, the first
  // still-open edge out of the stage is the one that leads away from it.
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
   * Evaluate a guard expression against a session context.
   * Single point of change for guard evaluation logic (DSL compatibility, etc.).
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
   * Derive the current stage from a WorkflowSession.
   */
  deriveStage(session: WorkflowSession, evaluationContext: GuardEvaluationContext = {}): StageId {
    const facts = toSessionFacts(session);
    const guardContext = toGuardContext(session);
    return deriveStageFn(facts, this.config.stageAssignments, (expr) =>
      this.evaluateGuard(expr, guardContext, evaluationContext)
    );
  }

  /**
   * Validate a stage transition. Evaluates every candidate edge from→to in
   * schema order — a schema may declare several edges between the same pair
   * with different guards. Returns the first that passes, or the first failure.
   *
   * Converts session to SessionFacts internally if a session is provided.
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
   * Agents allowed to drive workflow task state.
   *
   * Task status is what `allTasksCompleted()` and `hasPendingTasks()` read, so
   * an agent that can set it can close its own stage. Control therefore sits
   * with the orchestrator unless a schema says otherwise.
   */
  /**
   * The workflow's stages, merged across every schema the profile resolves to.
   *
   * The single source for stage lookups: a profile resolves to several schema
   * files, and searching them one by one gives whichever the search order
   * happened to reach — a parent's guard here, a child's roster there.
   */
  getStages(): Record<string, StageDef> {
    return this.config.stages ?? {};
  }

  /**
   * The stage a session starts in — the first one the workflow declares.
   *
   * `compileWorkflow` computed this and nobody read it, so session creation
   * wrote the literal `'planning'`. A schema declaring `start → done` then
   * produced a session parked in a stage it does not declare: no outgoing
   * edge, no admission, and no error to say why. `deriveStage` answers the
   * different question of where an existing session is now.
   */
  getInitialStage(): string {
    return initialStageOf(this.config.stages);
  }

  /**
   * The stage that cycles over the named task list, if any.
   *
   * Loops nest, and this searched only the top level — so admission could
   * start a nested loop's task while the result handler, asking the same
   * question here, got nothing: the task reported success and stayed
   * `running` behind `no loop stage resolved`.
   *
   * `$currentTask.id` also used to match any key at all. It names the list of
   * the task being worked on, whose key is that task's id, so it matches one.
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

  /** The agents this workflow declares as editors. */
  getEditingAgents(): string[] {
    return this.config.editingAgents ?? [];
  }

  /**
   * Try to apply the first matching outgoing transition from the current stage.
   *
   * Scans ALL transitions from the current derived stage,
   * validates each one's guard and gate requirements, and applies the first
   * that passes by setting `session.currentStage`.
   *
   * Returns the result of the transition that was applied (if any).
   * Returns `{ allowed: false, applied: false }` when no outgoing transition matches.
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

      // The candidate in hand, not one looked up again by its endpoints: a
      // schema may declare several edges between the same two stages, and
      // re-finding by `from`/`to` judges the first of them every time — so an
      // alternative edge whose guard does hold is never reached.
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
   * A loop stage represents a new round of work when entered again. Without
   * resetting its task list, a rejected outer validation re-enters execution
   * with completed tasks; the next read immediately satisfies
   * allTasksCompleted() and consumes another retry without doing any work.
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
