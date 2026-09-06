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
 */
export type TaskMovement =
  | { kind: 'move'; to: string; effects: TransitionDef['effects'] }
  | { kind: 'complete' }
  /** Nothing applies: the task waits where it is, and `reason` says why. */
  | { kind: 'stay'; reason: string };

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
  evaluateGuard: (_expression: string, _task: TaskFacts) => boolean
): TaskMovement {
  if (!loopStage) return { kind: 'stay', reason: 'no loop stage resolved' };

  const transitions = loopStage.transitions ?? [];
  const nested = nestedStages(loopStage);

  if (transitions.length === 0) {
    // Declaration order: pass moves to the next stage, the last one completes
    // the task, and a failure is handled by the caller's retry budget.
    if (!passed) return { kind: 'stay', reason: `stage ${run.stage} did not pass` };
    const current = nested.findIndex((entry) => entry.id === run.stage);
    if (current < 0) {
      return { kind: 'stay', reason: `stage ${run.stage} is not one of this loop's stages` };
    }
    const next = nested[current + 1];
    return next ? { kind: 'move', to: next.id, effects: undefined } : { kind: 'complete' };
  }

  const facts = taskFactsOf(run);
  const outgoing = transitions.filter((transition) => transition.from === run.stage);

  const blocked: string[] = [];
  for (const transition of outgoing) {
    if (transition.guard && !evaluateGuard(transition.guard, facts)) {
      blocked.push(`${transition.from} → ${transition.to} (${transition.guard})`);
      continue;
    }
    if (transition.to === TASK_DONE) return { kind: 'complete' };
    return { kind: 'move', to: transition.to, effects: transition.effects };
  }

  // A stage nobody can leave is not a stage where the work ended. Completing
  // here would skip whatever the blocked guards were protecting — the verify
  // stage, most obviously — so the task waits, and the guards that held it are
  // named. A loop declares its ending with `to: done`.
  if (outgoing.length === 0) {
    return passed
      ? { kind: 'complete' }
      : { kind: 'stay', reason: `stage ${run.stage} did not pass and leads nowhere` };
  }
  return {
    kind: 'stay',
    reason: blocked.length
      ? `no transition out of ${run.stage} applies: ${blocked.join('; ')}`
      : `no transition out of ${run.stage} applies`,
  };
}

/** The stage a task enters the loop at. */
export function entryStageOf(loopStage: StageDef | null): string | undefined {
  return firstNestedStageId(loopStage);
}
