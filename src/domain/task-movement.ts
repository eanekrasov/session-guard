import type { StageDef, TransitionDef } from '../schema/types.ts';
import { nestedStages, firstNestedStageId } from '../schema/types.ts';
import type { GateStatus, LoopRun } from '../session/session-schema.ts';

/**
 * Where a task goes once its current stage has a verdict.
 *
 * A stage inside a loop is a stage like any other, so what moves a task is the
 * loop's own `transitions`. When a loop declares none, the nested stages run in
 * declaration order — the simple linear case stays simple, and a profile only
 * writes transitions when it needs a branch, a retry, or a skip.
 *
 * `blocked` — a route exists but a guard or consent blocks it. The caller
 * must NOT fall through to a retry budget: a transition that is explicitly
 * shut is a policy decision, not a missing route.
 *
 * `unreachable` — there is no applicable transition at all, so a retry
 * budget (or operator decision) is the only way the task can move.
 */
export type TaskMovement =
  | { kind: 'move'; to: string; effects: TransitionDef['effects'] }
  | { kind: 'complete'; effects: TransitionDef['effects'] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unreachable'; reason: string };

/**
 * The transition target that ends a task's work inside a loop.
 *
 * A loop's stages describe the work; finishing it is a departure like any
 * other, so it is written as one. Naming it explicitly is what keeps "the task
 * is done" apart from "every way out of here is currently blocked".
 */
export const TASK_DONE = 'done';

/** Facts a guard inside a loop is evaluated against. */
export interface TaskFacts {
  id: string;
  stage: string;
  status: LoopRun['status'];
  gates: Record<string, GateStatus>;
}

export function taskFactsOf(run: LoopRun): TaskFacts {
  return { id: run.taskId, stage: run.stage, status: run.status, gates: { ...run.gates } };
}

/**
 * Decide the next stage for a task whose current stage just resolved.
 *
 * `passed` says whether the stage's own verdict was a pass; guards decide the
 * rest. A transition is chosen only when its guard holds, so a loop that
 * declares transitions never moves a task by accident — if nothing matches, the
 * task stays where it is and the reason is visible in its gates.
 */
export function nextTaskStage(
  loopStage: StageDef | null,
  run: LoopRun,
  passed: boolean,
  evaluateGuard: (_expression: string, _task: TaskFacts) => boolean,
  hasConsent: (_type: string) => boolean = () => true
): TaskMovement {
  if (!loopStage) {
    return { kind: 'unreachable', reason: 'no loop stage resolved' };
  }

  const transitions = loopStage.transitions ?? [];
  const nested = nestedStages(loopStage);
  const facts = taskFactsOf(run);

  // A stage's own exit guards hold it shut. They are checked before any
  // departure — including the one that ends the task — because a stage that
  // says it is not finished is not finished, whatever a transition allows.
  const current = nested.find((entry) => entry.id === run.stage);
  const closed = (current?.exitGuards ?? []).find((guard) => !evaluateGuard(guard, facts));
  if (closed !== undefined) {
    return { kind: 'blocked', reason: `exit guard of ${run.stage} does not hold: ${closed}` };
  }

  if (transitions.length === 0) {
    // Declaration order: pass moves to the next stage, the last one completes
    // the task, and a failure is handled by the caller's retry budget.
    if (!passed) {
      return { kind: 'unreachable', reason: `stage ${run.stage} did not pass` };
    }
    const current = nested.findIndex((entry) => entry.id === run.stage);
    if (current < 0) {
      return { kind: 'unreachable', reason: `stage ${run.stage} is not one of this loop's stages` };
    }
    const next = nested[current + 1];
    return next
      ? { kind: 'move', to: next.id, effects: undefined }
      : { kind: 'complete', effects: undefined };
  }

  const outgoing = transitions.filter((transition) => transition.from === run.stage);

  const blockedReasons: string[] = [];
  for (const transition of outgoing) {
    if (transition.guard && !evaluateGuard(transition.guard, facts)) {
      blockedReasons.push(`${transition.from} → ${transition.to} (${transition.guard})`);
      continue;
    }
    // Consent is a decision by the operator, and it is required at either
    // level. A transition inside a loop that asks for one and does not have it
    // is as blocked as the guard version — including a transition that ends the
    // task, which is exactly where a release would be asked for.
    const consent = consentTypeOf(transition.consent);
    if (consent && !hasConsent(consent)) {
      blockedReasons.push(
        `${transition.from} → ${transition.to} (awaiting consent: ${consent})`
      );
      continue;
    }
    // The edge that ends a task carries its effects like any other: an
    // approval granted on the way out is granted.
    if (transition.to === TASK_DONE) return { kind: 'complete', effects: transition.effects };
    return { kind: 'move', to: transition.to, effects: transition.effects };
  }

  // A stage nobody can leave is not a stage where the work ended. Completing
  // here would skip whatever the blocked guards were protecting — the verify
  // stage, most obviously — so the task waits, and the guards that held it are
  // named. A loop declares its ending with `to: done`.
  if (outgoing.length === 0) {
    return passed
      ? { kind: 'complete', effects: undefined }
      : { kind: 'unreachable', reason: `stage ${run.stage} did not pass and leads nowhere` };
  }
  // All candidate transitions are blocked by guard/consent — this is a policy
  // decision, not a missing route. The caller must NOT fall through to retry.
  return {
    kind: 'blocked',
    reason: blockedReasons.length
      ? `no transition out of ${run.stage} applies: ${blockedReasons.join('; ')}`
      : `no transition out of ${run.stage} applies`,
  };
}

/** The approval a transition asks for, in either declared shape. */
function consentTypeOf(consent: TransitionDef['consent']): string {
  if (!consent) return '';
  return typeof consent === 'string' ? consent : (consent.type ?? '');
}

/** The stage a task enters the loop at. */
export function entryStageOf(loopStage: StageDef | null): string | undefined {
  return firstNestedStageId(loopStage);
}
