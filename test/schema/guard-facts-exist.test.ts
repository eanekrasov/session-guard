import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { GuardEvaluator } from '../../src/schema/guard-evaluator.ts';
import { toGuardContext } from '../../src/domain/engine.ts';
import { createSession } from '../../src/session/session-store.ts';
import { approve } from '../../src/domain/approvals.ts';
import { setGateStatus } from '../../src/session/helpers.ts';
import { createTask } from '../support/task-factory.ts';
import type { StageDef } from '../../src/schema/types.ts';

/**
 * A guard may name a fact this project does not have.
 *
 * The compiler parses every expression now, so a syntax error is caught at
 * load — but `session.taskLists.implementation` parses perfectly and then
 * reads `false` for ever, because the list of task lists is `session.tasks`.
 * The base fixture carried exactly that for months: its `uncommitted →
 * execution` rule never fired once, and nothing was red.
 *
 * The evaluator already reports the read through `onError`. This walks the
 * whole corpus and listens.
 */

/**
 * Resolved from this file, not from `process.cwd()` — another test in the
 * suite chdirs into a temporary repository, and relative roots then find
 * nothing while reporting success.
 */
const REPO = join(import.meta.dirname, '..', '..');
const ROOTS = [
  join(REPO, 'profiles'),
  join(REPO, 'test/fixtures/profiles'),
  join(REPO, 'scripts/host-smoke/profile'),
];

interface Expression {
  where: string;
  expression: string;
}

function collect(where: string, schema: Record<string, unknown>): Expression[] {
  const found: Expression[] = [];
  const push = (path: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') {
      found.push({ where: `${where}:${path}`, expression: value });
    }
  };

  for (const [index, rule] of (
    (schema.stageAssignments as Array<Record<string, unknown>>) ?? []
  ).entries()) {
    push(`stageAssignments[${index}].condition`, rule.condition);
  }

  const walkTransitions = (path: string, list: unknown): void => {
    for (const [index, transition] of ((list as Array<Record<string, unknown>>) ?? []).entries()) {
      push(`${path}[${index}].guard`, transition.guard);
    }
  };
  walkTransitions('transitions', schema.transitions);

  const walkStage = (path: string, stage: StageDef): void => {
    for (const [index, guard] of (stage.entryGuards ?? []).entries()) {
      push(`${path}.entryGuards[${index}]`, guard);
    }
    for (const [index, guard] of (stage.exitGuards ?? []).entries()) {
      push(`${path}.exitGuards[${index}]`, guard);
    }
    walkTransitions(`${path}.transitions`, stage.transitions);
    for (const [id, nested] of Object.entries(stage.stages ?? {})) {
      walkStage(`${path}.stages.${id}`, nested);
    }
  };
  for (const [id, stage] of Object.entries((schema.stages as Record<string, StageDef>) ?? {})) {
    walkStage(`stages.${id}`, stage);
  }

  return found;
}

function everyExpression(): Expression[] {
  const found: Expression[] = [];
  for (const root of ROOTS) {
    let profiles: string[];
    try {
      profiles = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const dir = join(root, profile);
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
        const parsed = parseYaml(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          found.push(...collect(`${root}/${profile}/${file}`, parsed));
        }
      }
    }
  }
  return found;
}

/** A session with something of everything, so a guard has facts to read. */
function probeContext(): Record<string, unknown> {
  const session = createSession('guard-probe', 'base', 'session-guard', 'planning');
  approve(session, 'plan', 'evidence', 'call-1');
  session.refs.plan = '.opencode/plan/x/plan.md';
  session.tasks.implementation = [createTask({ status: 'pending' })];
  for (const gate of ['invariants', 'review', 'qa', 'checkout', 'build', 'test', 'deploy']) {
    setGateStatus(session, gate, 'passed');
  }
  const task = { id: 'task-1', status: 'running', gates: {}, round: 0 };
  return toGuardContext(session, task) as unknown as Record<string, unknown>;
}

describe('every guard in the corpus reads facts that exist', () => {
  const expressions = everyExpression();

  it('finds guards to check at all', () => {
    expect(expressions.length).toBeGreaterThan(20);
  });

  it('evaluates each one without reaching for a fact this project does not have', () => {
    const context = probeContext();
    const broken: string[] = [];

    for (const { where, expression } of expressions) {
      const evaluator = new GuardEvaluator(context, undefined, {}, (error, expr) => {
        broken.push(`${where}\n    ${String(expr)}\n    ${(error as Error).message}`);
      });
      evaluator.evaluate(expression);
    }

    expect(broken).toEqual([]);
  });
});
