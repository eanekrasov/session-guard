// ─── Public Types Barrel ───────────────────────────────────────────────────────
//
// Single import point for all public types.
// Usage: import type { WorkflowSession, TaskToolArgs } from 'session-guard/types'

// Profile / Schema
export type {
  ProfileSchema,
  StageDef,
  StageAssignmentRule,
  TransitionDef,
  TransitionEffect,
  DispatchDef,
  ConsentOnTransition,
  ProfileRetryBudget,
  LoopSource,
} from '../schema/profile-schema.ts';

export type {
  ProfileMetadata,
  ResolvedMetadata,
  ResolvedSchema,
  LoadedProfile,
  ResolvedProfile,
  ProfileConfigurationIssue,
  ProfileConfigurationError,
} from '../schema/types.ts';

// YAML Input Schemas
export {
  ProfileYamlSchema,
  StageYamlSchema,
  TransitionYamlSchema,
  ActionEntryYamlSchema,
  RetryBudgetYamlSchema,
  LoopSourceYamlSchema,
  ActionIdYamlSchema,
  DispatchYamlSchema,
  StageAssignmentRuleYamlSchema,
  TransitionEffectYamlSchema,
  ConsentOnTransitionYamlSchema,
} from '../schema/yaml-schemas.ts';

// Session / Runtime
export type {
  GateStatus,
  TaskStatus,
  LoopRunStatus,
  ApprovalStatus,
  Severity,
  ViolationStatus,
  StageGateResult,
  Approval,
  ActiveOperation,
  ActiveTaskContext,
  RetryBudget,
  PendingDecision,
  MutationTask,
  LoopRun,
  Verification,
  ValidationRecord,
  DeliveryPermit,
  WorkflowOutcome,
  WorkflowSession,
  WorkflowSessionRead,
} from '../session/session-schema.ts';

// Session Facts / Guard Evaluation
export type { GuardEvaluationSession, SessionFacts } from '../domain/session-facts.ts';

export { toSessionFacts } from '../domain/session-facts.ts';

// Session Snapshot (for UI/dashboard/TUI)
export type { SessionSnapshot } from './session-snapshot.ts';
export { toSessionSnapshot } from './session-snapshot.ts';

// Tool Arguments
export type {
  BashToolArgs,
  ReadToolArgs,
  WriteToolArgs,
  EditToolArgs,
  GlobToolArgs,
  GrepToolArgs,
  ApplyPatchToolArgs,
  TaskToolArgs,
  ToolArgsMap,
  ToolArgs,
} from '../app/tool-args.ts';

// Engine
export type { SessionGuardEngine, EvaluateGuardFn } from '../domain/engine.ts';

// Invariants
export type { InvariantViolation, InvariantCheck, InvariantResult } from '../app/invariants.ts';
