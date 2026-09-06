import { nestedStages } from './types.ts';
import type {
  StageDef,
  TransitionDef,
  ResolvedSchema,
  StageAssignmentRule,
} from './types.ts';

// ─── Compiled Types ──────────────────────────────────────────────────────────

/** One nested stage of a loop, addressed as `<owner>/<nested>`. */
export interface CompiledNode {
  id: string;
  /** The stage that owns the loop this node runs in. */
  owner: string;
  /** The nested stage itself. */
  stage: string;
  allowedAgents: string[];
  entryGuards: string[];
  exitGuards: string[];
}

export interface CompiledTransition {
  from: string;
  to: string;
  guard: string | null;
  kind: 'auto' | 'pass' | 'fail';
  effects: CompiledTransitionEffect[];
  consent: string | null;
  onFailure: 'retry' | 'terminal' | null;
}

export interface CompiledTransitionEffect {
  bumpRetry: string | null;
  maxAttempts: number | null;
  approve: string | null;
}

export interface CompiledStage {
  id: string;
  loop: string | null;
  dispatch: CompiledDispatch | null;
  retryBudget: number | null;
  nodes: CompiledNode[];
  exitGuards: string[];
  allowedAgents: string[];
}

export interface CompiledDispatch {
  strategy: 'serial' | 'parallel' | 'serial_with_overlap';
  maxConcurrent: number;
  overlapRoles: string[];
}

export interface CompiledStageAssignment {
  id: string;
  priority: number;
  condition: string;
  result: string;
}

export interface CompiledWorkflow {
  version: 1;
  stages: Record<string, CompiledStage>;
  transitions: CompiledTransition[];
  stageAssignments: CompiledStageAssignment[];
  initialStage: string;
  terminalStages: string[];
}

export interface CompileError {
  path: string;
  message: string;
}

// ─── Compiler ────────────────────────────────────────────────────────────────

const TERMINAL_STAGES = new Set(['done', 'terminal', 'completed', 'failed', 'cancelled']);

/**
 * Compile a resolved schema into a `CompiledWorkflow`.
 *
 * Normalises defaults, validates cross-references, and produces
 * a deterministic execution contract. Rejects unsupported declarations.
 */
export function compileWorkflow(schema: ResolvedSchema): {
  workflow: CompiledWorkflow;
  errors: CompileError[];
} {
  const errors: CompileError[] = [];

  // Collect stage IDs
  const stageIds = new Set(Object.keys(schema.stages ?? {}));

  // Build compiled stages with normalised defaults
  const compiledStages: Record<string, CompiledStage> = {};
  for (const [stageId, stageDef] of Object.entries(schema.stages ?? {})) {
    const compiledNodes = compileNodes(stageId, stageDef, stageIds, errors);

    compiledStages[stageId] = {
      id: stageId,
      loop: stageDef.loop ?? null,
      dispatch: compileDispatch(stageDef.dispatch, errors),
      retryBudget: stageDef.retryBudget?.maximum ?? null,
      nodes: compiledNodes,
      exitGuards: stageDef.exitGuards ?? [],
      allowedAgents: stageDef.allowedAgents ?? [],
    };
  }

  // A stage's `gates:` is checked against what the profile declares, not
  // against a list of names kept in the compiler. A profile that declares no
  // gates has nothing to check against, so the check is skipped rather than
  // guessed at.
  const declaredGates = schema.gates ? new Set(schema.gates.map((gate) => gate.id)) : null;

  for (const [stageId, stageDef] of Object.entries(schema.stages ?? {})) {
    validateNestedStages(stageId, stageDef, declaredGates, errors);
  }

  // Build compiled transitions
  const compiledTransitions = compileTransitions(schema.transitions ?? [], stageIds, errors);

  // Build compiled stage assignments
  const compiledAssignments = compileAssignments(schema.stageAssignments ?? [], errors);

  // Determine initial stage (first stage assignment result, or first stage)
  let initialStage = '';
  if (compiledAssignments.length > 0) {
    initialStage = compiledAssignments[0].result;
  } else if (stageIds.size > 0) {
    initialStage = stageIds.values().next().value as string;
  }

  // Determine terminal stages (stages whose transitions lead to none, or explicitly named)
  const terminalStages = findTerminalStages(stageIds, compiledTransitions);

  return {
    workflow: {
      version: 1,
      stages: compiledStages,
      transitions: compiledTransitions,
      stageAssignments: compiledAssignments,
      initialStage,
      terminalStages,
    },
    errors,
  };
}

/** The transition target that ends a task's work; never a stage of its own. */
const TASK_DONE = 'done';

/**
 * Check a stage's own stages and transitions.
 *
 * These are the rules the runtime would otherwise discover one failed workflow
 * at a time: a transition to a stage that does not exist, a gate the profile
 * never declared, a retry budget belonging to something other than the task.
 *
 * `declaredGates` is `null` when the profile declares no gates at all — there
 * is then nothing to compare against, and no gate name is rejected.
 */
function validateNestedStages(
  stageId: string,
  stageDef: StageDef,
  declaredGates: Set<string> | null,
  errors: CompileError[]
): void {
  const nested = nestedStages(stageDef);
  const nestedIds = new Set(nested.map((entry) => entry.id));

  if (stageDef.loop && (stageDef.transitions?.length ?? 0) > 0) {
    const ends = (stageDef.transitions ?? []).some((transition) => transition.to === TASK_DONE);
    if (!ends) {
      errors.push({
        path: `stages.${stageId}.transitions`,
        message: `Loop "${stageId}" declares transitions but none of them reaches "${TASK_DONE}", so no task can ever finish it`,
      });
    }
  }

  if (stageDef.loop && nested.length === 0) {
    errors.push({
      path: `stages.${stageId}`,
      message: `Stage "${stageId}" cycles over "${stageDef.loop}" but declares no stages to run`,
    });
  }

  if (!stageDef.loop && (stageDef.transitions?.length ?? 0) > 0) {
    errors.push({
      path: `stages.${stageId}.transitions`,
      message: `Stage "${stageId}" declares transitions but no loop to move a task through`,
    });
  }

  for (const entry of nested) {
    for (const gate of entry.gates ?? []) {
      if (declaredGates && !declaredGates.has(gate)) {
        errors.push({
          path: `stages.${stageId}.stages.${entry.id}.gates`,
          message: `Gate "${gate}" is not a gate this profile declares`,
        });
      }
    }
    validateNestedStages(`${stageId}.stages.${entry.id}`, entry, declaredGates, errors);
  }

  for (const gate of stageDef.gates ?? []) {
    if (declaredGates && !declaredGates.has(gate)) {
      errors.push({
        path: `stages.${stageId}.gates`,
        message: `Gate "${gate}" is not a gate this profile declares`,
      });
    }
  }

  for (const transition of stageDef.transitions ?? []) {
    // `done` is not a stage: it is how a loop says the task's work is over.
    const endpoints = [transition.from, ...(transition.to === TASK_DONE ? [] : [transition.to])];
    for (const endpoint of endpoints) {
      if (!nestedIds.has(endpoint)) {
        errors.push({
          path: `stages.${stageId}.transitions`,
          message: `Transition ${transition.from} → ${transition.to} names "${endpoint}", which is not a stage of "${stageId}"`,
        });
      }
    }
    for (const effect of transition.effects ?? []) {
      if (effect.bumpRetry !== undefined && effect.bumpRetry !== 'task.id') {
        errors.push({
          path: `stages.${stageId}.transitions`,
          message: `Transition ${transition.from} → ${transition.to} bumps "${effect.bumpRetry}"; inside a loop the budget is the task's own, written as task.id`,
        });
      }
    }
  }
}

function compileNodes(
  stageId: string,
  stageDef: StageDef,
  _stageIds: Set<string>,
  _errors: CompileError[]
): CompiledNode[] {
  return nestedStages(stageDef).map((stage) => ({
    id: `${stageId}/${stage.id}`,
    owner: stageId,
    stage: stage.id,
    allowedAgents: stage.allowedAgents ?? stageDef.allowedAgents ?? [],
    entryGuards: stage.entryGuards ?? [],
    exitGuards: stage.exitGuards ?? [],
  }));
}

function compileDispatch(
  dispatch: StageDef['dispatch'],
  _errors: CompileError[]
): CompiledDispatch | null {
  if (!dispatch) return null;
  if (typeof dispatch === 'object' && 'strategy' in dispatch) {
    const d = dispatch as {
      strategy: 'serial' | 'parallel' | 'serial_with_overlap';
      maxConcurrent?: number;
      overlapRoles?: string[];
    };
    return {
      strategy: d.strategy,
      maxConcurrent: d.maxConcurrent ?? (d.strategy === 'serial' ? 1 : 2),
      overlapRoles: d.overlapRoles ?? [],
    };
  }
  return null;
}

function compileTransitions(
  transitions: TransitionDef[],
  stageIds: Set<string>,
  errors: CompileError[]
): CompiledTransition[] {
  return transitions.map((t, i) => {
    if (!stageIds.has(t.from)) {
      errors.push({ path: `transitions[${i}]`, message: `Unknown source stage '${t.from}'` });
    }
    if (!stageIds.has(t.to)) {
      errors.push({ path: `transitions[${i}]`, message: `Unknown target stage '${t.to}'` });
    }

    return {
      from: t.from,
      to: t.to,
      guard: t.guard ?? null,
      kind: t.kind ?? 'auto',
      effects: (t.effects ?? []).map((e) => ({
        bumpRetry: e.bumpRetry ?? null,
        maxAttempts: e.maxAttempts ?? null,
        approve: e.approve ?? null,
      })),
      consent: typeof t.consent === 'string' ? t.consent : (t.consent?.type ?? null),
      onFailure: t.onFailure ?? null,
    };
  });
}

function compileAssignments(
  assignments: StageAssignmentRule[],
  _errors: CompileError[]
): CompiledStageAssignment[] {
  return [...assignments]
    .sort((a, b) => b.priority - a.priority)
    .map((a) => ({
      id: a.id,
      priority: a.priority,
      condition: a.condition,
      result: a.result,
    }));
}

function findTerminalStages(stageIds: Set<string>, transitions: CompiledTransition[]): string[] {
  const hasOutgoing = new Set<string>();
  for (const t of transitions) {
    hasOutgoing.add(t.from);
  }
  const terminals: string[] = [];
  for (const pid of stageIds) {
    if (TERMINAL_STAGES.has(pid.toLowerCase())) {
      terminals.push(pid);
    } else if (!hasOutgoing.has(pid)) {
      terminals.push(pid);
    }
  }
  return terminals;
}
