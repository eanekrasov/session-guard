import { describe, expect, it } from 'vitest';
import { nextTaskStage } from '../../src/domain/task-movement.ts';
import type { StageDef } from '../../src/schema/types.ts';
import type { LoopRun } from '../../src/session/session-schema.ts';

/**
 * What moves a task between the stages of a loop.
 *
 * A loop that declares no transitions runs its stages in declaration order —
 * the simple case stays simple. A loop that declares them is moved by them,
 * and by nothing else.
 */

function runAt(stage: string, gates: LoopRun['gates'] = {}): LoopRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    listKey: 'implementation',
    ancestry: [],
    stage,
    status: 'running',
    gates,
  };
}

const linear: StageDef = {
  loop: 'implementation',
  stages: { code: {}, verify: { gates: ['review', 'qa'] } },
};

const branching: StageDef = {
  loop: 'implementation',
  stages: { code: {}, verify: { gates: ['review', 'qa'] }, commit: {} },
  transitions: [
    { from: 'code', to: 'verify' },
    { from: 'verify', to: 'commit', guard: "task.gates.review == 'passed'" },
    {
      from: 'verify',
      to: 'code',
      guard: "task.gates.review == 'failed'",
      effects: [{ bumpRetry: 'task.id' }],
    },
  ],
};

/** Evaluate a guard the way the runtime does: against the task's own facts. */
function evaluate(expression: string, facts: { gates: Record<string, string> }): boolean {
  const match = /task\.gates\.(\w+) == '(\w+)'/.exec(expression);
  if (!match) throw new Error(`unexpected guard in test: ${expression}`);
  return facts.gates[match[1]!] === match[2];
}

describe('a loop with no transitions runs its stages in order', () => {
  it('moves to the next stage on a pass', () => {
    expect(nextTaskStage(linear, runAt('code'), true, evaluate)).toEqual({
      kind: 'move',
      to: 'verify',
      effects: undefined,
    });
  });

  it('completes the task after the last stage', () => {
    expect(nextTaskStage(linear, runAt('verify'), true, evaluate)).toEqual({ kind: 'complete' });
  });

  it('leaves a failure to the loop retry budget', () => {
    expect(nextTaskStage(linear, runAt('verify'), false, evaluate)).toMatchObject({
      kind: 'unreachable',
    });
  });
});

describe('a loop with transitions is moved by them', () => {
  it('takes the branch whose guard holds', () => {
    const run = runAt('verify', { review: 'passed', qa: 'passed' });
    expect(nextTaskStage(branching, run, true, evaluate)).toEqual({
      kind: 'move',
      to: 'commit',
      effects: undefined,
    });
  });

  it('takes the failure branch and its retry effect', () => {
    const run = runAt('verify', { review: 'failed', qa: 'passed' });
    expect(nextTaskStage(branching, run, false, evaluate)).toEqual({
      kind: 'move',
      to: 'code',
      effects: [{ bumpRetry: 'task.id' }],
    });
  });

  it('stays put when no guard holds — never moves by accident', () => {
    const run = runAt('verify', { review: 'pending' });
    const movement = nextTaskStage(branching, run, false, evaluate);
    expect(movement.kind).toBe('blocked');
    // The reason names the guards that held it, so a stalled task is a
    // question with an answer rather than a silence.
    expect(movement.kind === 'blocked' && movement.reason).toContain('verify → commit');
  });

  it('completes on a stage nothing leads out of', () => {
    expect(nextTaskStage(branching, runAt('commit'), true, evaluate)).toEqual({ kind: 'complete' });
  });

  it('waits rather than completing when every way out is blocked', () => {
    // The stage passed, but the only edge out of it is guarded and does not
    // apply. Completing here would skip whatever that guard protects — the
    // verify stage, most obviously. The task waits instead.
    const run = runAt('verify', { review: 'passed', qa: 'passed' });
    const onlyFailureEdge: StageDef = {
      loop: 'implementation',
      stages: { code: {}, verify: { gates: ['review', 'qa'] } },
      transitions: [
        { from: 'code', to: 'verify' },
        { from: 'verify', to: 'code', guard: "task.gates.review == 'failed'" },
      ],
    };
    const movement = nextTaskStage(onlyFailureEdge, run, true, evaluate);
    expect(movement.kind, 'a blocked stage was mistaken for a finished one').toBe('blocked');
  });

  it('ends the task on an explicit `to: done`', () => {
    const withEnding: StageDef = {
      loop: 'implementation',
      stages: { code: {}, verify: { gates: ['review', 'qa'] } },
      transitions: [
        { from: 'code', to: 'verify' },
        { from: 'verify', to: 'done', guard: "task.gates.review == 'passed'" },
        { from: 'verify', to: 'code', guard: "task.gates.review == 'failed'" },
      ],
    };
    const passedRun = runAt('verify', { review: 'passed', qa: 'passed' });
    expect(nextTaskStage(withEnding, passedRun, true, evaluate)).toEqual({ kind: 'complete' });

    // And the ending is guarded like any other departure.
    const failedRun = runAt('verify', { review: 'failed' });
    expect(nextTaskStage(withEnding, failedRun, false, evaluate)).toMatchObject({
      kind: 'move',
      to: 'code',
    });
  });

  it('does not complete a terminal stage that has not passed', () => {
    expect(nextTaskStage(branching, runAt('commit'), false, evaluate)).toMatchObject({
      kind: 'unreachable',
    });
  });

  it('ignores declaration order once transitions exist', () => {
    // `code` is followed by `verify` both by order and by transition, but the
    // guard on the way out of `verify` is what decides — not the list.
    const run = runAt('verify', { review: 'passed' });
    const movement = nextTaskStage(branching, run, true, evaluate);
    expect(movement).toEqual({ kind: 'move', to: 'commit', effects: undefined });
  });
});

describe('a loop that is not there', () => {
  it('moves nothing', () => {
    expect(nextTaskStage(null, runAt('code'), true, evaluate)).toMatchObject({ kind: 'unreachable' });
  });
});

describe('what holds a task inside a stage', () => {
  const withConsent: StageDef = {
    loop: 'implementation',
    stages: { code: {}, verify: {} },
    transitions: [{ from: 'code', to: 'done', consent: 'release' }],
  };

  it('will not end a task on a transition whose consent has not been given', () => {
    const movement = nextTaskStage(withConsent, runAt('code'), true, evaluate, () => false);
    expect(movement.kind, 'a task finished without the consent its transition asked for').toBe(
      'blocked'
    );
    expect(movement.kind === 'blocked' && movement.reason).toContain('awaiting consent: release');
  });

  it('ends it once the operator has consented', () => {
    expect(nextTaskStage(withConsent, runAt('code'), true, evaluate, () => true)).toEqual({
      kind: 'complete',
    });
  });

  it('honours the consent declared as an object', () => {
    const objectForm: StageDef = {
      loop: 'implementation',
      stages: { code: {} },
      transitions: [{ from: 'code', to: 'done', consent: { type: 'release' } }],
    };
    expect(nextTaskStage(objectForm, runAt('code'), true, evaluate, () => false).kind).toBe(
      'blocked'
    );
  });

  it('keeps a stage shut while its own exit guard does not hold', () => {
    const guarded: StageDef = {
      loop: 'implementation',
      stages: { code: { exitGuards: ["task.gates.review == 'passed'"] }, verify: {} },
      transitions: [{ from: 'code', to: 'verify' }],
    };
    const movement = nextTaskStage(guarded, runAt('code'), true, evaluate);
    expect(movement.kind, 'the stage let the task out with its exit guard unmet').toBe('blocked');
    expect(movement.kind === 'blocked' && movement.reason).toContain('exit guard');
  });

  it('lets it out once the exit guard holds', () => {
    const guarded: StageDef = {
      loop: 'implementation',
      stages: { code: { exitGuards: ["task.gates.review == 'passed'"] }, verify: {} },
      transitions: [{ from: 'code', to: 'verify' }],
    };
    const run = runAt('code', { review: 'passed' });
    expect(nextTaskStage(guarded, run, true, evaluate)).toMatchObject({ kind: 'move', to: 'verify' });
  });

  it('applies the exit guard to completion too, not only to a move', () => {
    // Declaration order: `verify` is the last stage, so passing it would end
    // the task. Its exit guard must still be asked.
    const guarded: StageDef = {
      loop: 'implementation',
      stages: { code: {}, verify: { exitGuards: ["task.gates.qa == 'passed'"] } },
    };
    expect(nextTaskStage(guarded, runAt('verify'), true, evaluate).kind).toBe('blocked');
  });
});
