# Proposal: Domain Layer — pure business logic for session-guard plugin

## 1. Change Overview

| Field | Value |
|-------|-------|
| **Name** | `domain-layer` |
| **Description** | Pure business logic layer — engine, derivation, workflow orchestration — sitting between Data Layer (config loading, session persistence) and Application Layer (plugin runtime, dashboard). |
| **Intent** | Implement the Domain layer per the architecture in `docs/layers.md`. Domain receives resolved config objects and `SessionFacts` read-models (never raw `WorkflowSession`), contains no I/O, and exposes pure functions and a thin engine wrapper for the Application Layer to call. |

## 2. MVP Scope

Six source modules + one barrel export + one modified barrel:

| # | Module | File | Description |
|---|--------|------|-------------|
| 1 | Domain types | `src/domain/types.ts` | Shared type aliases and enums: `PhaseId`, `GateStatus`, `ActionId`, `ApprovalStatus`, `TaskStatus`. Also exports the domain-only `SessionFacts` interface. |
| 2 | SessionFacts + projection | `src/domain/session-facts.ts` | `SessionFacts` interface (read-model projection from `WorkflowSession`) + `toSessionFacts(session: WorkflowSession): SessionFacts` transformer. Domain only ever sees `SessionFacts`, never raw `WorkflowSession`. |
| 3 | Phase derivation | `src/domain/derive-phase.ts` | `derivePhase(facts: SessionFacts, rules: PhaseAssignmentRule[]): PhaseId` — priority-ordered matching against config-driven rule set. Phase is derived, never stored. |
| 4 | Transition validation | `src/domain/validate-transition.ts` | `checkTransition(from: PhaseId, to: PhaseId, transitions: Transition[], session?: SessionFacts): string \| null` — lookup `from→to` pair in transitions array, evaluate optional guard expression via `evaluateGuard()`. Returns error message or null. |
| 5 | SessionGuardEngine | `src/domain/engine.ts` | Class wrapping a `SessionGuardConfig`-like merged config object + guard evaluator. Public methods: `derivePhase(session)`, `canPerformAction(session, action)`, `checkTransition(from, to, session?)`. The Application Layer constructs the engine once per session with the merged config. |
| 6 | Workflow orchestration | `src/domain/workflow.ts` | Pure functions that mutate a `WorkflowSession` directly: `beginMutation()`, `canCommit()`, `approvePlan()`, `declinePlan()`, `markBugVerified()`, `finishMutation()`, `parseWorkflowResult()`, `isExpiredMutation()`, `hasLiveVerifier()`. These are business operations that read and write session state — same pattern as the parent `workflow.ts`. |
| 7 | Barrel export | `src/domain/index.ts` | Re-exports all domain types and functions from the six modules above. |
| 8 | Main index update | `src/index.ts` | Adds re-exports of domain symbols alongside existing Data Layer and Session Store exports. |

## 3. Design Decisions

### D1. SessionFacts is a domain-only type, not a persistence type

**Decision**: `SessionFacts` lives in the Domain layer. `toSessionFacts()` transforms `WorkflowSession` → `SessionFacts`. Domain layer functions never receive a raw `WorkflowSession`.

**Rationale**: Clean Architecture dependency rule. Domain must not depend on persistence-layer types. `SessionFacts` is a projection that contains only what domain logic needs — no `schemaVersion`, `updatedAt`, `baselineHashes`, etc. This also makes tests simpler: test helpers construct `SessionFacts` directly without building a full `WorkflowSession`.

**Impact**: App Layer calls `toSessionFacts(session)` before calling pure domain functions. Engine's `derivePhase()` method internally calls `toSessionFacts()`.

### D2. PhaseAssignments come from config, not hardcoded

**Decision**: `derivePhase()` receives `PhaseAssignmentRule[]` from the caller. It does not import or hardcode rules.

**Rationale**: Resolved config already has `phaseAssignments: PhaseAssignmentRule[]` in every `ResolvedSchema`. The parent project has hardcoded `DERIVE_PHASE_RULES`, but the plugin's multi-profile design requires rules to be config-driven. Each rule has a `priority` (higher wins), `condition` (JS expression evaluated with `evaluateGuard` against SessionFacts), and `result` (target phase id).

**Impact**: The Engine or Application Layer passes the merged `PhaseAssignmentRule[]` array when calling `derivePhase()`.

### D3. SessionFacts contains only necessary facts — flattened and simplified

**Decision**: SessionFacts is a flat projection with these fields:

| Field | Type | Source |
|-------|------|--------|
| `commitHash` | `string \| null` | `session.commitHash` |
| `commitPermit` | `{ allowed: boolean } \| null` | `session.commitPermit` |
| `planApproved` | `boolean` | `session.approvals.some(a => a.type === 'plan' && a.status === 'granted')` |
| `tasks` | `PlanTask[]` | `session.tasks` |
| `activeOperation` | `{ mutationId: string; status: TaskStatus } \| null` | `session.activeOperation` |
| `testStatus` | `TaskStatus` | `session.testStatus` |
| `bugVerified` | `boolean` | `session.bugVerified` |
| `gates` | `Record<string, GateStatus>` | Flattened from `session.gates` array |
| `profileId` | `string` | `session.profileId` |

**Rationale**: Domain logic needs gates as a flat `Record<string, GateStatus>` for quick lookups (e.g., `gates.review === 'passed'`). The `planApproved` boolean is derived from approvals array filtered by type `'plan'` — domain should not know about array traversal. `profileId` replaces the parent's `preset` field.

### D4. checkTransition works with config-driven Transition[]

**Decision**: `checkTransition(from, to, transitions, session?)` receives a `Transition[]` array and optional `SessionFacts`. It finds the matching `from→to` entry, evaluates its optional guard, and returns `null` on success or an error string on failure.

**Rationale**: Same pattern as parent `state.ts:checkTransition()`, but data-driven (receives array) rather than loading config internally. This keeps the function pure — the caller (Engine or App Layer) is responsible for providing the merged transitions.

**Impact**: Guards in transitions use `evaluateGuard()` against a `SessionFacts` object (not `WorkflowSession`). The guard expression references `session.gates.*`, `session.planApproved`, etc.

### D5. Workflow functions mutate WorkflowSession directly (pragmatic choice)

**Decision**: `workflow.ts` functions accept and mutate a `WorkflowSession` object directly, just like the parent `workflow.ts`.

**Rationale**: Workflow operations (beginMutation, approvePlan, finishMutation) are inherently stateful — they both read and write session fields. Passing `SessionFacts` for reads and returning mutation instructions would create needless indirection for a function set that maps 1:1 to session mutations. The parent project follows this pattern successfully.

**Constraint**: Workflow functions must use `setGateStatus()`, `bumpRetry()`, etc. from `session-schema.ts` (Data Layer) to mutate gates and retry budgets — they should not manipulate those fields directly.

### D6. SessionGuardEngine wraps config + guard evaluator

**Decision**: `SessionGuardEngine` class receives a `SessionGuardConfig`-like merged object at construction time and internally calls `toSessionFacts()` + `derivePhase()` + `evaluateGuard()`.

**API**:
```
class SessionGuardEngine {
  constructor(config: SessionGuardConfig)
  derivePhase(session: WorkflowSession): PhaseId
  canPerformAction(session: WorkflowSession, action: ActionId): { allowed: boolean; reason?: string }
  checkTransition(from: PhaseId, to: PhaseId, session?: WorkflowSession): string | null
}
```

**Rationale**: Mirror of parent `ConfigDrivenSessionGuard`. The engine is a thin convenience layer — calls `toSessionFacts()` internally, then delegates to pure functions. `canPerformAction()` checks profile-level and phase-level guards against the session.

### D7. Reuses existing evaluateGuard()

**Decision**: Domain layer imports `evaluateGuard` directly from `src/guard-evaluator.ts`. No changes needed to that file.

**Rationale**: `evaluateGuard()` is already a pure function with no side effects — it belongs to the Data Layer but has no I/O. The parent project does the same. Cross-layer import from Domain → Data is allowed (clean architecture: Domain depends on Data interfaces).

### D8. Config merge happens outside domain

**Decision**: Domain receives a plain merged config object (`SessionGuardConfig`). The Application Layer (or future runtime adaptor) is responsible for merging `ResolvedSchema[]` into a single config with all `phaseAssignments`, `transitions`, `gateMapping`, `actionGuards`, etc.

**Rationale**: Config merging belongs in the Data Layer (schema resolution) or Application Layer (runtime setup). Domain should not know about schema inheritance, `extends` chains, or file paths. This keeps the domain testable without loading real config files.

## 4. Field Mapping — Parent SessionFacts to Plugin SessionFacts

| Parent `SessionFacts` field | Plugin `SessionFacts` field | Notes |
|---|---|---|
| `commitHash: string \| null` | `commitHash: string \| null` | Same semantics |
| `commitPermit: { callID: string } \| null` | `commitPermit: { allowed: boolean } \| null` | Plugin CommitPermit has boolean flag instead of callID. Domain only needs to know if permit exists. |
| `pendingPlanApproval: PendingPlanApproval \| null` | (no direct analog) | Plugin tracks approvals as `ApprovalStep[]` with `type: string` (e.g., `'plan'`). Domain derives `planApproved` by type. |
| `planApproved: boolean` | `planApproved: boolean` | Derived from `approvals.some(a => a.type === 'plan' && a.status === 'granted')` in `toSessionFacts()`. |
| `tasks: PlanTask[]` | `tasks: PlanTask[]` | Same concept, different PlanTask shape (plugin has `assignedTo`, no `branch` or `manifest`). |
| `activeMutation: { agent: string } \| null` | `activeOperation: { mutationId: string; status: TaskStatus } \| null` | Different field names. Plugin's ActiveOperation has `mutationId` + `status` (TaskStatus). |
| `testStatus: Record<string, GateStatus>` | `testStatus: TaskStatus` | Parent is per-task map; plugin is a single `TaskStatus` value (simpler model). |
| `bugVerified: boolean` | `bugVerified: boolean` | Same |
| `gates: Record<string, GateStatus>` | `gates: Record<string, GateStatus>` | Same (parent already flattens gates in toSessionFacts) |
| `preset: 'low' \| 'medium' \| 'high'` | `profileId: string` | Renamed + different semantics. Plugin identifies profiles by string ID, not preset level. |

## 5. Data Flow

```
Application Layer
    │
    │  1. resolveConfig(profileId) → ResolvedProfile
    │  2. Merge ResolvedSchema[] → SessionGuardConfig
    │  3. Create engine = new SessionGuardEngine(config)
    │
    ▼
SessionGuardEngine (src/domain/engine.ts)
    │
    ├── derivePhase(session):
    │     toSessionFacts(session) → SessionFacts
    │     derivePhase(facts, config.phaseAssignments) → PhaseId
    │
    ├── canPerformAction(session, action):
    │     toSessionFacts(session) → SessionFacts
    │     evaluateGuard(actionGuard, session, guards)  ← Data Layer
    │     // plus phase-level entry/exit guards
    │     → { allowed: boolean, reason?: string }
    │
    └── checkTransition(from, to, session?):
          toSessionFacts(session) → SessionFacts       ← if session provided
          checkTransition(from, to, config.transitions, facts) → string | null
               │
               └── lookup Transition[] for from→to pair
                   evaluateGuard(guard, facts, guards)  ← Data Layer
                   → error message or null
    │
    ▼
Pure Domain Functions (no I/O, no side effects)
    │
    ├── src/domain/session-facts.ts
    │     toSessionFacts(WorkflowSession) → SessionFacts
    │
    ├── src/domain/derive-phase.ts
    │     derivePhase(SessionFacts, PhaseAssignmentRule[]) → PhaseId
    │
    ├── src/domain/validate-transition.ts
    │     checkTransition(from, to, Transition[], SessionFacts?) → string | null
    │
    └── src/domain/workflow.ts
          beginMutation(session, callId, agent): void
          canCommit(session, manifest?): boolean
          approvePlan(session, evidence, callId): void
          declinePlan(session, evidence, callId, feedback): void
          markBugVerified(session): void
          finishMutation(session, passed, changedFiles): void
          parseWorkflowResult(output): { stage, status, summary, evidence } | null
          isExpiredMutation(op, now?): boolean
          hasLiveVerifier(session, agent, now?): boolean
    │
    ▼
Data Layer (imported by Domain — no circular dependency)
    │
    ├── src/guard-evaluator.ts     ← evaluateGuard(expression, session, guards)
    └── src/session/session-schema.ts  ← setGateStatus, bumpRetry, etc. (used by workflow.ts)
```

### Pure-derivation path (for checkTransition and derivePhase):

```
WorkflowSession (session store)
    │  toSessionFacts()
    ▼
SessionFacts (domain)
    │
    ├── derivePhase(facts, rules)
    │     └── for each rule sorted by priority:
    │           evaluateGuard(rule.condition, facts, guards) → true → return rule.result
    │
    └── checkTransition(from, to, transitions, facts?)
          └── find transition.from === from && transition.to === to
                └── if guard: evaluateGuard(guard, facts, guards) → true → null, else error
```

## 6. Non-Goals (Hard Scope Boundary)

The following are explicitly **NOT** in this MVP:

| Component | Reason for exclusion |
|-----------|---------------------|
| `deriveStage()` | TUI-only display logic. The plugin has no TUI. Belongs in Application Layer or future dashboard server. |
| Config-driven phase rules compiler | MVP uses hardcoded `PhaseAssignmentRule[]` from resolved config. In P1 we can add a compiler that validates rules at config-parse time. |
| Dispatch engine (serial/parallel stage execution) | P1 feature. MVP has no multi-stage execution. |
| Invariant checking | P1. Requires runtime file validation. See `docs/layers.md`. |
| Manifest presets | P1. Predefined stage sequences (`feature → [dev, test, review, qa]`). |
| Guardrails | P2. Safety rules with severity levels. |
| Consent protocol | P2. Structured operator consent flow. |
| Application layer integration | Separate change. Domain is pure — integration with plugin runtime is next. |

## 7. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Plugin models are simpler than parent — some parent patterns may not map cleanly | Medium | Reduction is acceptable. Where parent has complex features (per-task testStatus, CommitPermit with callID), the plugin uses simpler equivalents (single testStatus, boolean allowed). If gaps are found during implementation, escalate for design review. |
| `evaluateGuard()` expects `session: object` but domain passes `SessionFacts` — type mismatch in guard expressions | Low | Guard expressions reference `session` context. Plugin guards will be written against `SessionFacts` fields. The runtime type is compatible (`object` is permissive). |
| Workflow functions mutate WorkflowSession but domain imports session-schema helpers — dependency coupling | Low | This is intentional and follows the parent pattern. `session-schema.ts` is a utility layer, not business logic. It provides field-level accessors that domain can safely call. |
| Config merge logic not yet defined — how PhaseAssignmentRule[] from multiple ResolvedSchema entries are combined | Medium | MVP assumes a single merged array. The Application Layer (or a future config-merging step) concatenates and deduplicates by `id`. Clarify in Implementation Design phase. |
| No existing `SessionGuardConfig` interface in the plugin — needs to be defined in engine.ts | Low | Define a minimal `SessionGuardConfig` as a TypeScript interface. Keep it in `engine.ts` or `src/domain/types.ts`. Accept that it will grow as P1/P2 features are added. |

## 8. Open Questions

1. **Config merge strategy**: How exactly should `PhaseAssignmentRule[]` and `Transition[]` from multiple `ResolvedSchema` entries be merged? Simple concatenation? By ID dedup? Should a schema with higher priority override lower priority transitions? **Proposal**: For MVP, concatenate arrays with the last-writer-wins rule for duplicate IDs. Formalize in the Spec phase.

2. **SessionGuardConfig structure**: Should `SessionGuardConfig` be defined in `src/domain/types.ts` or in a separate config-type file in `src/schema/`? The parent defines it in `config-driven.ts`. **Proposal**: Define the domain-facing `SessionGuardConfig` interface in `src/domain/types.ts` since it's a domain contract — the Data Layer shapes configs to match it, but the interface belongs with its consumer.

3. **canPerformAction guards**: The parent `ConfigDrivenSessionGuard.canPerformAction()` checks profile-level `actionGuards` then phase-level `entryGuards`/`exitGuards`. The plugin's `ResolvedSchema` has `actionGuards?: string[]` — flat array, not per-action. Should we expand it to `actionGuards?: Record<ActionId, string>`? **Proposal**: Keep the same flat `string[]` for MVP (check all action guards), expand to per-action `Record<ActionId, string>` in P1 if needed.

4. **workflow.ts guard check**: The parent `beginMutation()` checks `resolveConfig(session).actionGuards["beginMutation"]`. The plugin doesn't have `resolveConfig()` in the workflow module — should workflow functions also check action guards, or should that be the Engine's responsibility? **Proposal**: Workflow functions are thin mutators — guard checking is the Engine's job. Workflow functions assume all guards have passed before being called.

5. **parseWorkflowResult tag name**: The parent uses `<workflow-result>` XML tags. Should the plugin use the same tag? **Proposal**: Reuse the same tag for compatibility. The function signature is identical.
