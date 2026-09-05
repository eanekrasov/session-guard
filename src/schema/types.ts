export interface ProfileMetadata {
  id: string;
  description?: string;
  extends?: string;
  schemas?: string[];
  agentsDir?: string;
  skillsDir?: string;
  agents?: string[];
  skills?: string[];
  invariants?: string[];
}

export interface ResolvedMetadata {
  id: string;
  description?: string;
  agents: string[];
  skills: string[];
  invariants: string[];
  agentsDir: string;
  skillsDir: string;
}

export interface ProfileSchema {
  extends?: string;
  phases?: Record<string, PhaseDef>;
  transitions?: TransitionDef[];
  settings?: Record<string, unknown>;
  editingAgents?: string[];
  verifiers?: string[];
  requiredGates?: string[];
  actionGuards?: Record<string, string>;
  phaseAssignments?: PhaseAssignmentRule[];
}

export interface ResolvedSchema {
  source: string;
  phases?: Record<string, PhaseDef>;
  transitions?: TransitionDef[];
  settings?: Record<string, unknown>;
  editingAgents?: string[];
  verifiers?: string[];
  requiredGates?: string[];
  actionGuards?: Record<string, string>;
  phaseAssignments?: PhaseAssignmentRule[];
}

export interface PhaseAssignmentRule {
  id: string;
  priority: number;
  condition: string;
  result: string;
}

export interface LoadedProfile {
  id: string;
  description?: string;
  extends?: string;
  schemas?: string[];
  agentsDir?: string;
  skillsDir?: string;
  agents?: string[];
  skills?: string[];
  invariants?: string[];
}

export interface ResolvedProfile {
  metadata: ResolvedMetadata;
  schemas: ResolvedSchema[];
}

export interface ConsentOnTransition {
  /** Тип одобрения (plan, commit, ...) */
  type: string;
}

export interface TransitionEffect {
  bumpRetry?: string;
  maxAttempts?: number;
  /** Утвердить тип (type) при переходе */
  approve?: string;
}

export interface TransitionDef {
  from: string;
  to: string;
  guard?: string | null;
  kind?: 'auto' | 'pass' | 'fail';
  effects?: TransitionEffect[];
  /** Для перехода нужно одобрение пользователя */
  consent?: string | ConsentOnTransition;
  onFailure?: 'retry' | 'terminal';
}

export interface PhaseDef {
  loop?: string;
  dispatch?:
    | { strategy: 'serial'; overlapRoles?: string[] }
    | {
        strategy: 'parallel' | 'serial_with_overlap';
        maxConcurrent: number;
        overlapRoles?: string[];
      };
  retryBudget?: { maximum: number };
  stages?: StageDef[];
  exitGuards?: string[];
  allowedAgents?: string[];
}

export interface StageDef {
  id: string;
  allowedAgents?: string[];
  entryGuards?: string[];
  exitGuards?: string[];
}

export interface ProfileConfigurationIssue {
  path: string;
  message: string;
}

export class ProfileConfigurationError extends Error {
  readonly profileId: string;
  readonly schemaFilename: string;
  readonly path: string;
  readonly issues: ProfileConfigurationIssue[];

  constructor(profileId: string, schemaFilename: string, issues: ProfileConfigurationIssue[]) {
    const primaryIssue = issues[0] ?? { path: '(root)', message: 'Invalid schema' };
    super(
      `Profile "${profileId}" schema "${schemaFilename}" is invalid at ${primaryIssue.path}: ${primaryIssue.message}`
    );
    this.name = 'ProfileConfigurationError';
    this.profileId = profileId;
    this.schemaFilename = schemaFilename;
    this.path = primaryIssue.path;
    this.issues = issues;
  }
}
