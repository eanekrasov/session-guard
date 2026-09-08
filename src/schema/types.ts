// Типы, выведенные из Zod-схемы — единственный источник истины.
// Все изменения схемы в profile-schema.ts автоматически подхватываются.
export type {
  ProfileSchema,
  StageDef,
  StageAssignmentRule,
  TransitionDef,
  TransitionEffect,
  DispatchDef,
  ConsentOnTransition,
  RetryBudget,
  LoopSource,
  GateItem,
} from './profile-schema.ts';

import type {
  StageDef,
  StageAssignmentRule,
  TransitionDef,
  GateItem,
  TransitionEffect,
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

// ResolvedSchema — resolved версия ProfileSchema без extends.
// Индексная сигнатура для совместимости с z.infer (ProfileSchemaSchema.passthrough()).

/**
 * A stage's nested stages, in declaration order.
 *
 * YAML mappings keep their file order through the parser, so the first entry
 * is where a task enters the loop and the order is what movement falls back on
 * until the stage's own `transitions` drive it.
 */
/** The stage a task enters this loop at: the first nested stage declared. */
export function firstNestedStageId(
  stage: { stages?: Record<string, StageDef> } | null | undefined
): string | undefined {
  if (!stage) return undefined;
  return Object.keys(stage.stages ?? {})[0];
}

export function nestedStages(stage: {
  stages?: Record<string, StageDef>;
}): Array<{ id: string } & StageDef> {
  return Object.entries(stage.stages ?? {}).map(([id, def]) => ({ id, ...def }));
}

export interface ResolvedSchema {
  /**
   * The schema's name within its profile — its file name without the
   * extension. Unique inside the profile, and the second half of the
   * `<profileId>/<schemaId>` a session is created with.
   */
  id: string;
  source: string;
  stages?: Record<string, StageDef>;
  transitions?: TransitionDef[];
  editingAgents?: string[];
  /**
   * The gates this workflow declares.
   *
   * The compiler checks a stage's `gates:` against this, so a typo is caught
   * by comparing it with the profile that owns the workflow rather than with a
   * whitelist of names hardcoded in the compiler.
   */
  gates?: GateItem[];
  taskControlAgents?: string[];
  stageAssignments?: StageAssignmentRule[];
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
