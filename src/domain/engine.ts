import { type GuardEvaluationContext, GuardEvaluator } from '../schema/guard-evaluator.ts';
import type { TaskStatus, WorkflowSession } from '../session/session-schema.ts';
import type { StageAssignmentRule, StageDef, TransitionDef } from '../schema/types.ts';
import type { SessionFacts } from './session-facts.ts';
import { toSessionFacts } from './session-facts.ts';
import { bumpRetry } from '../session/helpers.ts';
import { approve } from './approvals.ts';

// ─── Domain-specific type aliases ──────────────────────────────────────────────

export type StageId = string;
export type ActionId = string;
export type { GateStatus, ApprovalStatus, TaskStatus } from '../session/session-schema.ts';

// ─── Value interfaces ─────────────────────────────────────────────────────────

export interface StageTransitionResult {
  allowed: boolean;
  reason?: string;
  nextStage?: StageId;
}

export interface WorkflowResult {
  stage: string;
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

// ─── Stage-level entry/exit guards keyed by action ────────────────────────────

export interface StageEntryExitGuards {
  entryGuards?: Partial<Record<ActionId, string[]>>;
  exitGuards?: Partial<Record<ActionId, string[]>>;
}

// ─── Engine config ────────────────────────────────────────────────────────────

export interface EngineConfig {
  stages?: Record<string, StageDef>;
  stageAssignments: StageAssignmentRule[];
  transitions: TransitionDef[];
  /** Action guards: action → guard expression (flat, priority resolved internally). */
  actionGuards?: Record<string, string>;
  /** Stage-level entry/exit guards keyed by stage id */
  stageLevelGuards?: Record<string, StageEntryExitGuards>;
  /** gate IDs that must pass for kind=pass transitions (schema-level, last wins) */
  requiredGates?: string[];
  /** agents allowed to drive workflow task state (schema-level, last wins) */
  taskControlAgents?: string[];
}

function consentType(consent: string | { type?: string }): string {
  return typeof consent === 'string' ? consent : (consent.type ?? '');
}

// ─── Transition validation result ──────────────────────────────────────────────

export interface TransitionCheck {
  allowed: boolean;
  kind?: 'auto' | 'pass' | 'fail';
  reason?: string;
  to?: string;
  guard?: string | null;
}

// ─── Inlined deriveStage (from derive-stage.ts) ────────────────────────────────

function deriveDefaultEvaluateGuard(expr: string, facts: SessionFacts): boolean {
  return new GuardEvaluator(facts as unknown as Record<string, unknown>).evaluate(expr);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * The context every guard is evaluated against.
 *
 * One normalisation for all of them. A guard reading `session.gates.invariants`
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

export function deriveStageFn(
  facts: SessionFacts,
  rules: StageAssignmentRule[],
  evaluateGuard?: (expr: string) => boolean
): string {
  if (rules.length === 0) {
    const currentStage = facts.currentStage;
    return currentStage ?? 'PLANNING';
  }
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  const guardFn = evaluateGuard ?? ((expr: string) => deriveDefaultEvaluateGuard(expr, facts));
  for (const rule of sorted) {
    if (guardFn(rule.condition)) return rule.result;
  }
  return 'PLANNING';
}

// ─── Inlined checkTransition (from validate-transition.ts) ───────────────────

/**
 * Look up the edge between two stages and say whether it may be taken.
 *
 * A schema may declare several edges between the same pair, distinguished by
 * their guards. This lookup returns the first of them, so callers that hold a
 * specific candidate must use `evaluateTransition` instead — checking one
 * candidate by its endpoints would silently judge a different edge.
 */
export function checkTransition(
  from: string,
  to: string,
  transitions: TransitionDef[],
  session?: SessionFacts & { requiredGates?: string[] },
  evaluateGuard?: (expr: string) => boolean
): TransitionCheck {
  const transition = transitions.find((t) => t.from === from && t.to === to);

  if (!transition) {
    return { allowed: false, reason: `Illegal stage transition: ${from} → ${to}` };
  }

  return evaluateTransition(transition, session, evaluateGuard);
}

/** Whether this exact edge may be taken. */
export function evaluateTransition(
  transition: TransitionDef,
  session?: SessionFacts & { requiredGates?: string[] },
  evaluateGuard?: (expr: string) => boolean
): TransitionCheck {
  const from = transition.from;
  const to = transition.to;
  const guard = transition.guard;
  if (guard && guard.trim() !== '' && session) {
    const passed = evaluateGuard
      ? evaluateGuard(guard)
      : new GuardEvaluator(session as unknown as Record<string, unknown>).evaluate(guard);
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

  const requiredGates = session?.requiredGates ?? [];

  if (transition.kind === 'pass') {
    const failedGates = requiredGates.filter(
      (g) => !session?.gates?.[g] || session.gates[g] !== 'passed'
    );
    if (failedGates.length > 0) {
      return {
        allowed: false,
        kind: 'pass',
        reason: `Transition ${from} → ${to} (kind=pass) requires gates [${failedGates.join(', ')}] to be 'passed', but they are not`,
        guard,
      };
    }
  }

  if (transition.kind === 'fail') {
    const anyFailed = requiredGates.some((g) => session?.gates?.[g] === 'failed');
    if (!anyFailed) {
      return {
        allowed: false,
        kind: 'fail',
        reason: `Transition ${from} → ${to} (kind=fail) requires at least one gate in [${requiredGates.join(', ')}] to be 'failed', but none are`,
        guard,
      };
    }
  }

  return { allowed: true, kind: transition.kind, to: transition.to, guard };
}

// ─── EvaluateGuardFn type ──────────────────────────────────────────────────────

export type EvaluateGuardFn = (
  expression: string,
  session: object,
  guards: Record<string, (...args: unknown[]) => unknown>,
  evaluationContext?: GuardEvaluationContext
) => boolean;

// ─── StateMachineEngine ────────────────────────────────────────────────────────

export class StateMachineEngine {
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
    session: object,
    evaluationContext: GuardEvaluationContext = {}
  ): boolean {
    return this.evaluateGuardFn(expression, session, {}, evaluationContext);
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
   * Check whether an action is allowed for the current session.
   *
   * Guard priority: stage-level → flat actionGuards.
   * Kind=pass/fail проверяется checkTransition при детекте фактического
   * перехода фаз — не блокирует beginMutation внутри текущей фазы.
   *
   * Returns { allowed: true } if no guard or guard passes, or
   * { allowed: false, reason } if the guard fails.
   */
  canPerformAction(
    session: WorkflowSession,
    action: ActionId,
    evaluationContext: GuardEvaluationContext = {}
  ): { allowed: boolean; reason?: string } {
    const facts = toGuardContext(session);
    const stage = this.deriveStage(session, evaluationContext);

    // Agent identity is not checked here. `tool.execute.before` knows which
    // agent a call belongs to only for `task` (via subagent_type), so
    // `allowedAgents` is enforced during task admission, not on every mutation.

    // Шаг 1: stage-level entry/exit guards
    const stageGuard = this.config.stageLevelGuards?.[stage];
    if (stageGuard) {
      const guards = stageGuard.entryGuards?.[action] || stageGuard.exitGuards?.[action];
      if (guards && guards.length > 0) {
        const allPassed = guards.every((g) =>
          this.evaluateGuardFn(g, facts, {}, evaluationContext)
        );
        if (!allPassed) {
          return {
            allowed: false,
            reason: `Stage-level guard failed for ${action} in stage ${stage}`,
          };
        }
      }
    }

    // Шаг 2: flat actionGuards
    const flatGuard = this.config.actionGuards?.[action];
    if (flatGuard) {
      const passed = this.evaluateGuardFn(flatGuard, facts, {}, evaluationContext);
      if (!passed) {
        return { allowed: false, reason: `Action guard failed for ${action}: ${flatGuard}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate a stage transition. Converts session to SessionFacts internally
   * if a session is provided, and injects requiredGates from engine config.
   */
  checkTransition(
    from: StageId,
    to: StageId,
    session?: WorkflowSession,
    evaluationContext: GuardEvaluationContext = {}
  ): TransitionCheck {
    const gates = this.config.requiredGates ?? ['invariants'];
    const baseFacts = session ? toGuardContext(session) : undefined;
    const facts = baseFacts ? { ...baseFacts, requiredGates: gates } : undefined;
    return checkTransition(
      from,
      to,
      this.config.transitions,
      facts,
      facts ? (expr) => this.evaluateGuard(expr, facts, evaluationContext) : undefined
    );
  }

  /**
   * P1-012: Get required gates for commit permit.
   */
  getRequiredGates(): string[] {
    return this.config.requiredGates ?? ['invariants'];
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

  /** The stage that cycles over the named task list, if any. */
  getLoopStage(listKey: string): StageDef | null {
    for (const stage of Object.values(this.getStages())) {
      if (stage.loop === listKey || stage.loop === '$currentTask.id') return stage;
    }
    return null;
  }

  getTaskControlAgents(): string[] {
    return this.config.taskControlAgents ?? ['orchestrator'];
  }

  /**
   * Try to apply the first matching outgoing transition from the current stage.
   *
   * Scans ALL transitions from the current derived stage (any kind: auto, pass, fail),
   * validates each one's guard and gate requirements, and applies the first
   * that passes by setting `session.currentStage`.
   *
   * Returns the result of the transition that was applied (if any).
   * Returns `{ allowed: false, applied: false }` when no outgoing transition matches.
   */
  tryApplyTransitions(
    session: WorkflowSession,
    evaluationContext: GuardEvaluationContext = {}
  ): TransitionCheck & { applied?: boolean } {
    const currentStage = this.deriveStage(session, evaluationContext);
    const facts = toGuardContext(session);

    const outgoing = this.config.transitions.filter((t) => t.from === currentStage);
    if (outgoing.length === 0) {
      return {
        allowed: false,
        reason: `No outgoing transitions from ${currentStage}`,
        applied: false,
      };
    }

    const gates = this.config.requiredGates ?? ['invariants'];
    const factsWithGates = { ...facts, requiredGates: gates };

    for (const transition of outgoing) {
      // The candidate in hand, not one looked up again by its endpoints: a
      // schema may declare several edges between the same two stages, and
      // re-finding by `from`/`to` judges the first of them every time — so an
      // alternative edge whose guard does hold is never reached.
      const result = evaluateTransition(transition, factsWithGates, (expr) =>
        this.evaluateGuard(expr, factsWithGates, evaluationContext)
      );

      if (result.allowed) {
        for (const effect of transition.effects ?? []) {
          if (effect.bumpRetry) {
            bumpRetry(session, effect.bumpRetry);
            if (effect.maxAttempts !== undefined) {
              session.retryBudgets[effect.bumpRetry].maximum = effect.maxAttempts;
            }
          }
          if (effect.approve) {
            approve(session, effect.approve, '', `transition:${currentStage}->${transition.to}`);
          }
        }
        session.currentStage = transition.to;
        return { ...result, applied: true };
      }
    }

    return {
      allowed: false,
      applied: false,
      reason: 'No matching outgoing transition from ' + currentStage,
    };
  }
}

// ─── Default guard evaluator ───────────────────────────────────────────────────

function defaultEvaluateGuard(
  expression: string,
  session: object,
  guards: Record<string, (...args: unknown[]) => unknown>,
  evaluationContext: GuardEvaluationContext = {}
): boolean {
  const evaluator = new GuardEvaluator(
    session as Record<string, unknown>,
    guards as Record<string, Function>,
    evaluationContext
  );
  return evaluator.evaluate(expression);
}
