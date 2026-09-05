// Типы, выведенные из Zod-схемы — единственный источник истины.
// Все изменения схемы в profile-schema.ts автоматически подхватываются.
export type {
  ProfileSchema,
  PhaseDef,
  PhaseAssignmentRule,
  TransitionDef,
  TransitionEffect,
  StageDef,
  DispatchDef,
  ConsentOnTransition,
  RetryBudget,
  LoopSource,
  GateItem,
  ToolItem,
} from './profile-schema.ts';

import type {
  PhaseDef,
  PhaseAssignmentRule,
  TransitionDef,
  TransitionEffect,
  StageDef,
} from './profile-schema.ts';

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

// ResolvedSchema — resolved версия ProfileSchema без extends/gates/tools/gateMapping.
// Индексная сигнатура для совместимости с z.infer (ProfileSchemaSchema.passthrough()).
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
  [key: string]: unknown;
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
