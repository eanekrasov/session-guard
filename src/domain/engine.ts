import { type GuardEvaluationContext, GuardEvaluator } from '../schema/guard-evaluator.ts';
import type { TaskStatus, WorkflowSession } from '../session/session-schema.ts';
import type { PhaseAssignmentRule, PhaseDef, TransitionDef } from '../schema/types.ts';
import type { SessionFacts } from './session-facts.ts';
import { toSessionFacts } from './session-facts.ts';
import { bumpRetry } from '../session/helpers.ts';
import { approve } from './approvals.ts';

// ─── Domain-specific type aliases ──────────────────────────────────────────────

export type PhaseId = string;
export type ActionId = string;
export type { GateStatus, ApprovalStatus, TaskStatus } from '../session/session-schema.ts';

// ─── Value interfaces ─────────────────────────────────────────────────────────

export interface PhaseTransitionResult {
  allowed: boolean;
  reason?: string;
  nextPhase?: PhaseId;
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

// ─── Stage-level config ───────────────────────────────────────────────────────

export interface StageConfig {
  allowedAgents?: string[];
  entryGuards?: string[];
  exitGuards?: string[];
}

// ─── Phase-level entry/exit guards keyed by action ────────────────────────────

export interface PhaseEntryExitGuards {
  entryGuards?: Partial<Record<ActionId, string[]>>;
  exitGuards?: Partial<Record<ActionId, string[]>>;
}

// ─── Engine config ────────────────────────────────────────────────────────────

export interface EngineConfig {
  phases?: Record<string, PhaseDef>;
  phaseAssignments: PhaseAssignmentRule[];
  transitions: TransitionDef[];
  /** Action guards: action → guard expression (flat, priority resolved internally). */
  actionGuards?: Record<string, string>;
  /** Phase-level entry/exit guards keyed by phase id */
  phaseLevelGuards?: Record<string, PhaseEntryExitGuards>;
  /** gate IDs that must pass for kind=pass transitions (schema-level, last wins) */
  requiredGates?: string[];
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

// ─── Inlined derivePhase (from derive-phase.ts) ────────────────────────────────

function deriveDefaultEvaluateGuard(expr: string, facts: SessionFacts): boolean {
  return new GuardEvaluator(facts as unknown as Record<string, unknown>).evaluate(expr);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toGuardContext(session: WorkflowSession): any {
  const facts = toSessionFacts(session);
  return Object.assign(facts, {
    tasks: session.tasks ?? {},
    loopRuns: session.loopRuns ?? {},
    pendingDecisions: session.pendingDecisions ?? [],
  });
}

export function derivePhaseFn(
  facts: SessionFacts,
  rules: PhaseAssignmentRule[],
  evaluateGuard?: (expr: string) => boolean
): string {
  if (rules.length === 0) {
    const currentPhase = facts.currentPhase;
    return currentPhase ?? 'PLANNING';
  }
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  const guardFn = evaluateGuard ?? ((expr: string) => deriveDefaultEvaluateGuard(expr, facts));
  for (const rule of sorted) {
    if (guardFn(rule.condition)) return rule.result;
  }
  return 'PLANNING';
}

// ─── Inlined checkTransition (from validate-transition.ts) ───────────────────

export function checkTransition(
  from: string,
  to: string,
  transitions: TransitionDef[],
  session?: SessionFacts & { requiredGates?: string[] },
  evaluateGuard?: (expr: string) => boolean
): TransitionCheck {
  const transition = transitions.find((t) => t.from === from && t.to === to);

  if (!transition) {
    return { allowed: false, reason: `Illegal phase transition: ${from} → ${to}` };
  }

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
      phaseAssignments: config.phaseAssignments ?? [],
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
   * Derive the current phase from a WorkflowSession.
   */
  derivePhase(session: WorkflowSession, evaluationContext: GuardEvaluationContext = {}): PhaseId {
    const facts = toSessionFacts(session);
    const guardContext = toGuardContext(session);
    return derivePhaseFn(facts, this.config.phaseAssignments, (expr) =>
      this.evaluateGuard(expr, guardContext, evaluationContext)
    );
  }

  /**
   * Check whether an action is allowed for the current session.
   *
   * Guard priority: phase-level → flat actionGuards.
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
    const phase = this.derivePhase(session, evaluationContext);

    // Шаг 0: phase-level allowedAgents
    const phaseConfig = Object.entries(this.config.phases ?? {}).find(([id]) => id === phase)?.[1];
    const allowed = phaseConfig?.allowedAgents;
    if (allowed && allowed.length > 0) {
      const agentId = evaluationContext.agentId;
      if (!agentId || !allowed.includes(agentId)) {
        return {
          allowed: false,
          reason: `Agent "${agentId ?? 'unknown'}" is not allowed in phase "${phase}". Allowed: ${allowed.join(', ')}`,
        };
      }
    }

    // Шаг 1: phase-level entry/exit guards
    const phaseGuard = this.config.phaseLevelGuards?.[phase];
    if (phaseGuard) {
      const guards = phaseGuard.entryGuards?.[action] || phaseGuard.exitGuards?.[action];
      if (guards && guards.length > 0) {
        const allPassed = guards.every((g) =>
          this.evaluateGuardFn(g, facts, {}, evaluationContext)
        );
        if (!allPassed) {
          return {
            allowed: false,
            reason: `Phase-level guard failed for ${action} in phase ${phase}`,
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
   * Validate a phase transition. Converts session to SessionFacts internally
   * if a session is provided, and injects requiredGates from engine config.
   */
  checkTransition(
    from: PhaseId,
    to: PhaseId,
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
   * Try to apply the first matching outgoing transition from the current phase.
   *
   * Scans ALL transitions from the current derived phase (any kind: auto, pass, fail),
   * validates each one's guard and gate requirements, and applies the first
   * that passes by setting `session.currentPhase`.
   *
   * Returns the result of the transition that was applied (if any).
   * Returns `{ allowed: false, applied: false }` when no outgoing transition matches.
   */
  tryApplyTransitions(
    session: WorkflowSession,
    evaluationContext: GuardEvaluationContext = {}
  ): TransitionCheck & { applied?: boolean } {
    const currentPhase = this.derivePhase(session, evaluationContext);
    const facts = toGuardContext(session);

    const outgoing = this.config.transitions.filter((t) => t.from === currentPhase);
    if (outgoing.length === 0) {
      return {
        allowed: false,
        reason: `No outgoing transitions from ${currentPhase}`,
        applied: false,
      };
    }

    const gates = this.config.requiredGates ?? ['invariants'];
    const factsWithGates = { ...facts, requiredGates: gates };

    for (const transition of outgoing) {
      const result = checkTransition(
        currentPhase,
        transition.to,
        this.config.transitions,
        factsWithGates,
        (expr) => this.evaluateGuard(expr, factsWithGates, evaluationContext)
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
            approve(session, effect.approve, '', `transition:${currentPhase}->${transition.to}`);
          }
        }
        session.currentPhase = transition.to;
        return { ...result, applied: true };
      }
    }

    return {
      allowed: false,
      applied: false,
      reason: 'No matching outgoing transition from ' + currentPhase,
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
