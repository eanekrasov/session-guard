import type {
  PhaseDef,
  StageDef,
  TransitionDef,
  ResolvedSchema,
  PhaseAssignmentRule,
} from './types.ts';

// ─── Compiled Types ──────────────────────────────────────────────────────────

export interface CompiledNode {
  id: string;
  phase: string;
  stage?: string;
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

export interface CompiledPhase {
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

export interface CompiledPhaseAssignment {
  id: string;
  priority: number;
  condition: string;
  result: string;
}

export interface CompiledWorkflow {
  version: 1;
  phases: Record<string, CompiledPhase>;
  transitions: CompiledTransition[];
  phaseAssignments: CompiledPhaseAssignment[];
  initialPhase: string;
  terminalPhases: string[];
}

export interface CompileError {
  path: string;
  message: string;
}

// ─── Compiler ────────────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['done', 'terminal', 'completed', 'failed', 'cancelled']);

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

  // Collect phase IDs
  const phaseIds = new Set(Object.keys(schema.phases ?? {}));

  // Build compiled phases with normalised defaults
  const compiledPhases: Record<string, CompiledPhase> = {};
  for (const [phaseId, phaseDef] of Object.entries(schema.phases ?? {})) {
    const compiledNodes = compileNodes(phaseId, phaseDef, phaseIds, errors);

    compiledPhases[phaseId] = {
      id: phaseId,
      loop: phaseDef.loop ?? null,
      dispatch: compileDispatch(phaseDef.dispatch, errors),
      retryBudget: phaseDef.retryBudget?.maximum ?? null,
      nodes: compiledNodes,
      exitGuards: phaseDef.exitGuards ?? [],
      allowedAgents: phaseDef.allowedAgents ?? [],
    };
  }

  // Build compiled transitions
  const compiledTransitions = compileTransitions(schema.transitions ?? [], phaseIds, errors);

  // Build compiled phase assignments
  const compiledAssignments = compileAssignments(schema.phaseAssignments ?? [], errors);

  // Determine initial phase (first phase assignment result, or first phase)
  let initialPhase = '';
  if (compiledAssignments.length > 0) {
    initialPhase = compiledAssignments[0].result;
  } else if (phaseIds.size > 0) {
    initialPhase = phaseIds.values().next().value as string;
  }

  // Determine terminal phases (phases whose transitions lead to none, or explicitly named)
  const terminalPhases = findTerminalPhases(phaseIds, compiledTransitions);

  return {
    workflow: {
      version: 1,
      phases: compiledPhases,
      transitions: compiledTransitions,
      phaseAssignments: compiledAssignments,
      initialPhase,
      terminalPhases,
    },
    errors,
  };
}

function compileNodes(
  phaseId: string,
  phaseDef: PhaseDef,
  _phaseIds: Set<string>,
  _errors: CompileError[]
): CompiledNode[] {
  const stages = phaseDef.stages ?? [];
  return stages.map((stage: StageDef) => ({
    id: `${phaseId}/${stage.id}`,
    phase: phaseId,
    stage: stage.id,
    allowedAgents: stage.allowedAgents ?? phaseDef.allowedAgents ?? [],
    entryGuards: stage.entryGuards ?? [],
    exitGuards: stage.exitGuards ?? [],
  }));
}

function compileDispatch(
  dispatch: PhaseDef['dispatch'],
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
  phaseIds: Set<string>,
  errors: CompileError[]
): CompiledTransition[] {
  return transitions.map((t, i) => {
    if (!phaseIds.has(t.from)) {
      errors.push({ path: `transitions[${i}]`, message: `Unknown source phase '${t.from}'` });
    }
    if (!phaseIds.has(t.to)) {
      errors.push({ path: `transitions[${i}]`, message: `Unknown target phase '${t.to}'` });
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
  assignments: PhaseAssignmentRule[],
  _errors: CompileError[]
): CompiledPhaseAssignment[] {
  return [...assignments]
    .sort((a, b) => b.priority - a.priority)
    .map((a) => ({
      id: a.id,
      priority: a.priority,
      condition: a.condition,
      result: a.result,
    }));
}

function findTerminalPhases(phaseIds: Set<string>, transitions: CompiledTransition[]): string[] {
  const hasOutgoing = new Set<string>();
  for (const t of transitions) {
    hasOutgoing.add(t.from);
  }
  const terminals: string[] = [];
  for (const pid of phaseIds) {
    if (TERMINAL_PHASES.has(pid.toLowerCase())) {
      terminals.push(pid);
    } else if (!hasOutgoing.has(pid)) {
      terminals.push(pid);
    }
  }
  return terminals;
}
