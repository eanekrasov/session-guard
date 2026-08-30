# Design: Domain Layer — pure business logic for state-machine plugin

| Field | Value |
|-------|-------|
| **Change** | `domain-layer` |
| **Phase** | Design |
| **Precedes** | Implementation (src/domain/ + tests) |
| **Depends on** | Proposal (`openspec/changes/domain-layer/proposal.md`), Spec (`openspec/changes/domain-layer/spec.md`) |

---

## 1. Architecture Overview

### 1.1 File Structure

```
src/domain/
├── types.ts               # Domain-only types: PhaseId, ActionId, GateStatus, ApprovalStatus,
│                          #   TaskStatus, PhaseTransitionResult, WorkflowResult, EngineConfig
├── session-facts.ts       # SessionFacts interface + toSessionFacts(WorkflowSession): SessionFacts
├── derive-phase.ts        # derivePhase(facts, rules): PhaseId
├── validate-transition.ts # checkTransition(from, to, transitions, session?): string | null
├── engine.ts              # StateMachineEngine class (wraps config + guard evaluator)
├── workflow.ts            # 9 workflow mutation functions
├── dispatch.ts            # 4 dispatch lifecycle functions
└── index.ts               # Barrel re-export
```

A flat structure is chosen over nested directories (see AD1 below). Each file is a single-responsibility module with zero I/O.

### 1.2 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Application Layer (future)                      │
│  Plugin runtime, dashboard, bridges — config merge, error handling  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ calls StateMachineEngine methods
                            │ calls toSessionFacts / workflow / dispatch
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Domain Layer (PURE LOGIC)                     │
│                                                                     │
│  ┌────────────┐  ┌──────────────┐  ┌─────────┐  ┌───────────┐     │
│  │ session-   │  │ derive-phase │  │ engine  │  │ workflow  │     │
│  │ facts.ts   │——▶│ .ts          │  │ .ts     │  │ .ts       │     │
│  └─────┬──────┘  └──────┬───────┘  └────┬────┘  └─────┬─────┘     │
│        │                │               │              │           │
│        │                │               │              │           │
│  ┌─────┴────────────────┴───────────────┴──────────────┴──────┐    │
│  │                     types.ts                               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────┐  ┌──────────────┐                                   │
│  │ validate-  │  │ dispatch.ts  │                                   │
│  │ transition │  │              │                                   │
│  └────────────┘  └──────────────┘                                   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ imports guard-evaluator (pure fn)
                            │ imports setGateStatus, bumpRetry (helpers)
                            │ receives WorkflowSession (type only)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Data Layer (EXISTING)                         │
│                                                                     │
│  src/guard-evaluator.ts      — evaluateGuard()                      │
│  src/session/session-schema.ts — setGateStatus, bumpRetry, etc.     │
│  src/schema/types.ts         — PhaseAssignmentRule, Transition, etc.│
│  src/session/types.ts        — WorkflowSession, ActiveOperation, etc.│
│  src/public-api.ts           — resolveConfig()                      │
└─────────────────────────────────────────────────────────────────────┘

    Session Store (JSON file / in-memory)
    ────────────────────────────────────
    WorkflowSession — the only mutable data object
```

### 1.3 Dependency Graph Between Domain Modules

```
types.ts ──────────────────────────────────────────────────────┐
    │                                                          │
    ├── session-facts.ts  (imports WorkflowSession + types)   │
    │       │                                                  │
    │       ├── derive-phase.ts (imports SessionFacts +       │
    │       │                       evaluateGuard)             │
    │       │                                                  │
    │       ├── validate-transition.ts (imports SessionFacts  │
    │       │                           + evaluateGuard)       │
    │       │                                                  │
    │       └── engine.ts (imports SessionFacts +              │
    │               derivePhase + checkTransition +          │
    │               evaluateGuard + EngineConfig)   │
    │                                                           │
    ├── workflow.ts  (imports WorkflowSession + evaluateGuard  │
    │                   + session-schema helpers)              │
    │                                                           │
    └── dispatch.ts  (imports WorkflowSession)                 │
```

**Key rule**: Domain modules may import from the Data Layer (`guard-evaluator.ts`, `session/session-schema.ts`, `public-api.ts`, schema/session types) but Data Layer must never import from Domain. This is the standard Clean Architecture dependency direction.

---

## 2. Architecture Decisions

### AD1: File Structure — flat under src/domain/ vs nested

| Option | Description |
|--------|-------------|
| **Chosen: Flat** (`src/domain/*.ts`) | All 8 source files co-located in one directory |
| Rejected: Nested (`src/domain/session/facts.ts`, `src/domain/engine/state-machine.ts`) | Sub-directories for logical grouping |

**Rationale**: The domain layer has exactly 8 source files — small enough that nested directories add ceremony without benefit. Every module can import from another with `./types.ts` or `./engine.ts`. Flat structure matches the parent project's layout (`state.ts`, `workflow.ts`, `dispatch.ts` at top level). If the domain grows beyond 15 files, we can split into sub-directories.

### AD2: SessionFacts location — domain (chosen) vs persistence layer

| Option | Description |
|--------|-------------|
| **Chosen: Domain** | `SessionFacts` interface + `toSessionFacts()` live in `src/domain/session-facts.ts` |
| Rejected: Persistence layer | Define `SessionFacts` in `src/session/types.ts` alongside `WorkflowSession` |

**Rationale**: Clean Architecture dependency rule. `SessionFacts` is a projection of only what domain logic needs — no `schemaVersion`, `updatedAt`, `baselineHashes`, etc. If it lived in the persistence layer, the domain would depend on persistence for its read-model. By keeping it in the domain, tests construct `SessionFacts` directly without building a full `WorkflowSession`.

**Impact**: App Layer calls `toSessionFacts(session)` before calling pure domain functions. Engine's `derivePhase()` and `canPerformAction()` internally call `toSessionFacts()`.

### AD3: SessionFacts fields — what goes in, what stays out

**Chosen field set**:

| Field | Included | Rationale |
|-------|----------|-----------|
| `commitHash` | ✅ | Needed for guard expressions |
| `commitPermit` | ✅ | Needed for commit readiness checks |
| `approvals` | ✅ | Needed for `granted(type)` guard expressions. Guard expressions use `granted('plan')` instead of `planApproved` — decoupled from derivation logic. |
| `lastApproval` | ✅ | Last approval element for guard expressions |
| `tasks` | ✅ | Needed for task completeness computation |
| `activeOperation` | ✅ | Needed for phase derivation (is something running?) |
| `testStatus` | ✅ | Needed for test-gating rules |
| `bugVerified` | ✅ | Needed for phase derivation |
| `gates` (flat record) | ✅ | Flattened for easy guard lookups |
| `profileId` | ✅ | Needed to match config |
| `schemaVersion` | ❌ | Persistence concern — irrelevant to domain logic |
| `revision` | ❌ | Optimistic concurrency — belongs to Data Layer |
| `sessionId` | ❌ | Storage identifier — domain doesn't need it |
| `updatedAt` | ❌ | Metadata — domain doesn't need timestamps for derivation |
| `refs` | ❌ | Generic key-value store — domain shouldn't read arbitrary refs |
| `retryBudgets` | ❌ | Handled via `bumpRetry()` helper, not read directly |
| `baselineHashes` | ❌ | Persistence detail for change tracking |
| `changedFiles` | ❌ | Written by workflow, not read by derivation |
| `invariantViolations` | ❌ | P1 invariant-checking feature |
| `title` | ❌ | Display-only metadata |
| `currentTaskIndex` | ❌ | Bookkeeping for task iteration |

**Rationale**: Every excluded field fails the test "Does domain logic need this value to make a correct decision about phase, transition, or action permission?" If the answer is no, it stays out. This makes `SessionFacts` stable — adding a new session field doesn't require changing `SessionFacts` unless domain rules need it.

### AD4: Approval check via `granted(type)` guard (chosen) vs stored `planApproved` boolean

| Option | Description |
|--------|-------------|
| **Chosen: Guard function** | `granted(type)` checks `session.approvals.some(a => a.type === type && a.status === 'granted')`. Available to all guard expressions via `createGrantedGuard(session)`. |
| Rejected: Derived `planApproved` field | `toSessionFacts()` computes `planApproved = session.approvals.some(a => a.type === 'plan' && a.status === 'granted')`; guard expressions reference `session.planApproved == true` |

**Rationale**: `planApproved` is a single boolean that conflates approval checking with the derivation logic in `toSessionFacts()`. The `granted(type)` function is decoupled — it works with any approval type, not just `'plan'`, and does not require a dedicated SessionFacts field. Guard expressions become self-documenting: `granted('plan')` reads as "has the plan been granted?" without knowing how it's computed.

Each `ApprovalStep` carries a `type: string` (e.g., `'plan'`, `'commit'`). The constant `PLAN_APPROVAL_TYPE = 'plan'` lives in `workflow.ts`, co-located with `approvePlan()` and `declinePlan()`. Guard expressions use the string literal directly.

**Impact**: `SessionFacts.approvals` projects `type` and `status` from `session.approvals`. The `granted` function is injected into `GuardEvaluator` at all evaluation points (derivePhase, checkTransition, canPerformAction). No `planApproved` field is needed.

### AD5: derivePhase signature — (facts, rules) vs (session, config) vs (config-driven)

| Option | Description |
|--------|-------------|
| **Chosen: (facts, rules)** | `derivePhase(facts: SessionFacts, rules: PhaseAssignmentRule[]): PhaseId` |
| Rejected: (session, config) | `derivePhase(session: WorkflowSession, config: Something): PhaseId` |
| Rejected: Config-driven (engine-only) | Only `engine.derivePhase()` exists, no standalone function |

**Rationale**: The function is pure — it derives a phase from facts and rules. Taking `SessionFacts` (not `WorkflowSession`) enforces the domain boundary. Taking `PhaseAssignmentRule[]` (not a full config object) makes the dependency explicit and makes the function testable without constructing a config. The Engine wraps this function for convenience.

### AD6: derivePhase evaluation — uses evaluateGuard() with SessionFacts context + granted

**Decision**: `derivePhase()` calls `evaluateGuard(rule.condition, facts, { granted: ... })` for each rule, where `granted` is a closure created via `createGrantedGuard(facts)`. The `SessionFacts` object is passed as the `session` parameter (matching `evaluateGuard`'s API).

**Rationale**: `evaluateGuard()` already supports safe-fail on runtime errors (returns `false`). By passing `SessionFacts` as the context, guard expressions reference `session.gates.*`, `session.testStatus`, etc. The `granted` function provides an implementation-agnostic way to check approval status.

**Guard expression examples**:
- `"granted('plan')"`
- `"session.gates.invariants == 'passed' && session.gates.review == 'passed'"`
- `"session.testStatus == 'completed'"`
- `"session.bugVerified == true"`

### AD7: checkTransition — config-driven Transition[] lookup + guard eval

**Decision**: `checkTransition(from, to, transitions, session?)` receives a `Transition[]` array. It finds the first matching `from→to` entry, evaluates its optional `guard` against the optional `SessionFacts`, and — crucially — evaluates the transition's `kind` field inside the same function:

- `kind === 'pass'`: checks that ALL `requiredGates` have `status === 'passed'`; otherwise blocked
- `kind === 'fail'`: checks that AT LEAST ONE `requiredGate` has `status === 'failed'`; otherwise blocked
- Other values (`'auto'`, `undefined`): no additional check

Returns `TransitionCheck { allowed: boolean; kind?: 'auto' | 'pass' | 'fail'; reason?: string; to?: string; guard?: string | null }` — an object instead of `string | null`.

**Rationale**: Same logic as parent `state.ts:checkTransition()` but data-driven. The parent loads config internally via `resolveConfig(session)`. The plugin receives the merged `Transition[]` array directly, keeping the function pure. The optional `session` parameter allows callers to skip guard evaluation (e.g., when validating a structural transition without a loaded session).

The `TransitionDef.kind` field is consumed directly inside `checkTransition`:
- `'auto'` — no kind-level check (handled by `engine.autoProceed()`)
- `'pass'` — validates all required gates are passed
- `'fail'` — validates at least one required gate is failed

The `requiredGates` array comes from `EngineConfig.requiredGates` (injected by the engine layer) and defaults to `['invariants']`.

### AD8: StateMachineEngine — class with config + guardFn (vs plain functions)

| Option | Description |
|--------|-------------|
| **Chosen: Class** | `StateMachineEngine` with constructor(config, evaluateGuardFn?) |
| Rejected: Plain functions | Export `derivePhase()`, `canPerformAction()`, `checkTransition()` as standalone functions |
| Rejected: Factory function | Create engine via `createEngine(config, guardFn)` returning an object |

**Rationale**: A class encapsulates shared config state and the guard evaluator, avoiding repeated parameter passing. The optional `evaluateGuardFn` parameter enables test injection (A mock can always return `false` to test guard rejection). This mirrors the parent `ConfigDrivenStateMachine` pattern. A class makes future lifecycle (e.g., config reload) trivial to add.

### AD9: canPerformAction — checks flat actionGuards only (no stage guards)

**Decision**: `engine.canPerformAction()` iterates over `this.config.actionGuards` (a flat `string[]`), evaluates each against `SessionFacts`, and returns `{ allowed: false, reason }` on the first failure. No per-action guard lookup, no phase-level `entryGuards`/`exitGuards`.

**Rationale**: MVP scope boundary per D9/D10 in the proposal. The parent `ConfigDrivenStateMachine.canPerformAction()` checks per-action `Record<ActionId, string>` and phase-level `entryGuards`/`exitGuards`. The plugin's `ResolvedSchema` currently has `actionGuards?: string[]` — a flat array. Per-action guards and phase-level guards are deferred to P1.

### AD10: Workflow functions as session mutators — immutable vs mutable

| Option | Description |
|--------|-------------|
| **Chosen: Mutable (in-place)** | Functions receive `WorkflowSession` and mutate it directly |
| Rejected: Immutable (return new session) | Functions return a new `WorkflowSession` or mutation instructions |

**Rationale**: The parent project follows the mutable pattern successfully. Workflow operations (`beginMutation`, `approvePlan`, `finishMutation`) inherently read and write session state. An immutable approach would require cloning the session on every operation, which is wasteful for a JSON-in-file persistence model. The `session-schema.ts` helpers (`setGateStatus`, `bumpRetry`) are also mutative — consistency with the Data Layer is more important than functional purity.

**Constraint**: Workflow functions do NOT check action guards. Guard checking is the Engine's responsibility (per D4/Q4 in the proposal). Workflow functions assume all guards have already passed before being called.

### AD11: Dispatch functions — adapted from parent, simplified for plugin model

**Decision**: 4 small functions extracted from the parent `dispatch.ts`, adapted for the plugin's field naming:

| Function | Parent equivalent | Plugin adaptation |
|----------|------------------|-------------------|
| `markOutputReady(callId, session)` | Sets `activeMutation.outputReady = true` | Sets `activeOperation.result = "output_ready"` |
| `clearActiveMutation(session)` | Sets `activeMutation = null` | Sets `activeOperation = null` |
| `getExecutionProgress(session)` | Counts committed tasks | Counts completed tasks (different status) |
| `canExitExecution(session)` | Checks `!activeMutation && tasks.every(t => t.status === "committed")` | Checks `!activeOperation && tasks.every(t => t.status === "completed")` |

**Rationale**: The parent uses `"committed"` as task final status; the plugin uses `"completed"`. The parent uses `activeMutation.outputReady` boolean; the plugin uses `activeOperation.result` string. These are naming/data-shape differences only — the logic is identical.

### AD12: EngineConfig — single config interface vs raw ResolvedSchema

| Option | Description |
|--------|-------------|
| **Chosen: Dedicated interface** | `EngineConfig { phaseAssignments, transitions, actionGuards, requiredGates }` |
| Rejected: Raw `ResolvedSchema[]` | Pass the merged array of `ResolvedSchema` objects directly |

**Rationale**: The engine needs exactly these fields from the merged config. `requiredGates` was added later for `kind=pass/fail` transition validation. A dedicated interface makes the contract explicit and stable. `ResolvedSchema` has many fields irrelevant to the engine (`editingAgents`, `verifiers`, `gateMapping`, `settings`, `phases` with stage definitions). Passing the full config would create an implicit dependency on the shape of `ResolvedSchema`. The caller (Application Layer) is responsible for merging `ResolvedSchema[]` into `EngineConfig` before construction.

### AD14: evaluateGuard reuse — reused as-is, called with SessionFacts context + granted guard

**Decision**: Domain imports `evaluateGuard` from `src/guard-evaluator.ts` directly. The `session` parameter is a `SessionFacts` object (not `WorkflowSession`). The `guards` parameter includes `granted` — a closure created via `createGrantedGuard(session)` that checks `approvals.some(a => a.type === type && a.status === 'granted')`.

**Rationale**: `evaluateGuard()` is already a pure function with no I/O. Its `session` parameter is typed as `object`, so passing a `SessionFacts` instance is type-safe. Guard expressions reference fields like `session.planApproved`, `session.gates.*` — these exist on `SessionFacts`. The function safe-fails on runtime errors by returning `false`, which is exactly the behavior we want for broken guard expressions.

The `granted` function is provided to all guard evaluation points (checkTransition, derivePhase, canPerformAction) to allow implementation-agnostic approval checks:

```typescript
// Guard expression — checks if any plan-type approval has status 'granted'
granted('plan')
```

This replaces `session.planApproved == true` in guard expressions, which was coupled to the derivation implementation in `toSessionFacts`.

**Guard expression examples**:
- `"granted('plan')"`
- `"session.gates.invariants == 'passed' && session.gates.review == 'passed'"`
- `"session.testStatus == 'completed'"`
- `"session.bugVerified == true"`

### AD13: autoProceed — automatic phase transitions via kind: auto

**Decision**: `StateMachineEngine.autoProceed(session)` scans the current phase's transitions for one with `kind: 'auto'`, evaluates its guard, and if allowed — sets `session.phaseOverride` to the target phase. This is called from the runtime after every `tool.execute.after` / `finishMutation`.

**Rationale**: Common workflow patterns (PLANNING → EXECUTION after plan approval) should not require explicit user action. The `kind` field on the transition definition declares this intent declaratively in the schema.

**Cross-cutting**: This replaces the separate `derivePhase` re-evaluation with a transitions-based approach. The actual auto-transition is still gated by the transition's guard, ensuring safety.

### AD15: Error handling — workflow functions throw on invariants, else return result objects

**Decision**:
- **Workflow functions**: Throw `Error` on invariant violations (e.g., `beginMutation` when an active non-expired operation exists). Never return error objects — the throw is the error path.
- **checkTransition**: Returns `TransitionCheck { allowed: boolean; kind?: ...; reason?: string; to?: string; guard?: string | null }` — an object with `allowed: false` + `reason` on failure, `allowed: true` on success. No throw.
- **derivePhase**: Always returns a `PhaseId` (string). Never fails — empty rules → `"PLANNING"` fallback.
- **canPerformAction**: Returns `{ allowed: boolean; reason?: string }`. No throw.
- **Engine**: Does not catch throws from workflow functions — the caller (Application Layer) is responsible for handling errors.

**Rationale**: The parent project follows the same pattern — workflow functions throw, pure derivation functions return result codes. Throwing in workflow is appropriate because an invariant violation is a programming error (caller should have checked guards first). checkTransition returns a result code because guard evaluation is a business decision, not a contract violation.

---

## 3. Interfaces (Full TypeScript)

### 3.1 `src/domain/types.ts`

```typescript
// ─── Status type aliases (domain-own, not from session/types.ts) ───

export type PhaseId = string;
export type ActionId = string;
export type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type ApprovalStatus = 'pending' | 'granted' | 'denied';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// ─── Value interfaces ───

export interface PhaseTransitionResult {
  allowed: boolean;
  reason?: string;
  nextPhase?: PhaseId;
}

export interface WorkflowResult {
  stage: string;
  status: 'pass' | 'fail';
  summary: string;
  evidence: string[];
}

// ─── Engine config ───

export interface EngineConfig {
  phaseAssignments: PhaseAssignmentRule[];
  transitions: Transition[];
  actionGuards: string[]; // flat array — all evaluated for any action (MVP scope)
}
```

### 3.2 `src/domain/session-facts.ts`

```typescript
import type { ApprovalStep, PlanTask, WorkflowSession } from '../session/types.ts';
import type { GateStatus, TaskStatus } from './types.ts';

export interface SessionFacts {
  commitHash: string | null;
  commitPermit: { allowed: boolean } | null;
  lastApproval: { type: string; callId: string; status: 'pending' | 'granted' | 'denied'; grantedAt?: string; evidence?: string; feedback?: string } | null;
  approvals: Array<{ type: string; status: string }>;
  tasks: PlanTask[];
  activeOperation: { mutationId: string; status: TaskStatus } | null;
  testStatus: TaskStatus;
  bugVerified: boolean;
  gates: Record<string, GateStatus>;
  profileId: string;
}

export function toSessionFacts(session: WorkflowSession): SessionFacts;
```

### 3.3 `src/domain/derive-phase.ts`

```typescript
import type { PhaseAssignmentRule } from '../schema/types.ts';
import type { SessionFacts } from './session-facts.ts';

export function derivePhase(
  facts: SessionFacts,
  rules: PhaseAssignmentRule[],
): string;
```

### 3.4 `src/domain/validate-transition.ts`

```typescript
import type { Transition } from '../schema/types.ts';
import type { SessionFacts } from './session-facts.ts';

export interface TransitionCheck {
  allowed: boolean;
  kind?: 'auto' | 'pass' | 'fail';
  reason?: string;
  to?: string;
  guard?: string | null;
}

/** kind=pass/fail gate validation — requiredGates injected via session */
export function checkTransition(
  from: string,
  to: string,
  transitions: Transition[],
  session?: SessionFacts & { requiredGates?: string[] },
): TransitionCheck;
```

### 3.5 `src/domain/engine.ts`

```typescript
import type { WorkflowSession } from '../session/types.ts';
import type {
  ActionId,
  EngineConfig,
  PhaseId,
} from './types.ts';
import type { SessionFacts } from './session-facts.ts';

export type EvaluateGuardFn = (
  expression: string,
  session: object,
  guards: Record<string, (...args: unknown[]) => unknown>,
) => boolean;

export class StateMachineEngine {
  constructor(
    config: EngineConfig,
    evaluateGuardFn?: EvaluateGuardFn,
  );

  derivePhase(session: WorkflowSession): PhaseId;
  canPerformAction(
    session: WorkflowSession,
    action: ActionId,
  ): { allowed: boolean; reason?: string };
  checkTransition(
    from: PhaseId,
    to: PhaseId,
    session?: WorkflowSession,
  ): string | null;
}
```

### 3.6 `src/domain/workflow.ts` — All 9 function signatures

```typescript
import type { WorkflowSession } from '../session/types.ts';
import type { WorkflowResult } from './types.ts';

export function beginMutation(
  session: WorkflowSession,
  mutationId: string,
): void;

export function canCommit(
  session: WorkflowSession,
  requiredGates: string[],
): boolean;

export function approvePlan(
  session: WorkflowSession,
  evidence: string,
  callId: string,
): void;

export function declinePlan(
  session: WorkflowSession,
  evidence: string,
  callId: string,
  feedback: string,
): void;

export function markBugVerified(session: WorkflowSession): void;

export function finishMutation(
  session: WorkflowSession,
  passed: boolean,
  changedFiles: string[],
): void;

export function parseWorkflowResult(
  output: string,
): WorkflowResult | null;

export function isExpiredMutation(
  session: WorkflowSession,
): boolean;

export function hasLiveVerifier(
  session: WorkflowSession,
  agent: string,
): boolean;
```

### 3.7 `src/domain/dispatch.ts` — All 4 function signatures

```typescript
import type { WorkflowSession } from '../session/types.ts';

export function markOutputReady(
  callId: string,
  session: WorkflowSession,
): void;

export function clearActiveMutation(session: WorkflowSession): void;

export function getExecutionProgress(
  session: WorkflowSession,
): { completed: number; total: number; active: number };

export function canExitExecution(session: WorkflowSession): boolean;
```

---

## 4. Data Flow

### 4.1 `StateMachineEngine.derivePhase()`

```
session: WorkflowSession
    │
    ▼
toSessionFacts(session)
    │
    ▼
SessionFacts { planApproved, gates, testStatus, bugVerified, ... }
    │
    ▼
derivePhase(facts, config.phaseAssignments)
    │
    ├── sort rules by priority descending
    │
    ├── for each rule:
    │     │
    │     ├── evaluateGuard(rule.condition, facts, {})
    │     │     │
    │     │     ├── true  → return rule.result  (matched)
    │     │     ├── false → continue to next rule
    │     │     └── error → safe-fail → false → continue
    │
    └── no match → return "PLANNING" (fallback)
    │
    ▼
PhaseId (string)
```

### 4.2 `StateMachineEngine.canPerformAction()`

```
session: WorkflowSession, action: ActionId
    │
    ▼
toSessionFacts(session)
    │
    ▼
SessionFacts
    │
    ▼
for each guardExpr in config.actionGuards[]:
    │
    ├── evaluateGuard(guardExpr, facts, {})
    │     │
    │     ├── false → return { allowed: false, reason: "Action guard failed: {guardExpr}" }
    │     └── true  → continue
    │
    └── all guards passed → return { allowed: true }
```

### 4.3 `StateMachineEngine.checkTransition()`

```
from: PhaseId, to: PhaseId, session?: WorkflowSession
    │
    ├── if session provided → toSessionFacts(session) → SessionFacts
    │                         └── inject this.config.requiredGates
    └── if no session       → undefined
    │
    ▼
checkTransition(from, to, config.transitions, facts?)
    │
    ├── find t in transitions[] where t.from === from && t.to === to
    │     │
    │     ├── not found → return { allowed: false, reason: "Illegal..." }
    │     │
    │     └── found:
    │           │
    │           ├── no guard / guard empty → skip guard check
    │           │
    │           └── has guard:
    │                 │
    │                 ├── no session → skip guard check (bypass)
    │                 │
    │                 └── session provided:
    │                       │
    │                       ├── evaluateGuard(guard, facts, {}) == true  → continue
    │                       └── evaluateGuard == false → return { allowed: false, reason }
    │
    ├── evaluate kind:
    │     │
    │     ├── kind === 'pass':
    │     │     ├── all gates in requiredGates have status 'passed' → continue
    │     │     └── some gate not 'passed' → return { allowed: false, kind: 'pass', reason }
    │     │
    │     ├── kind === 'fail':
    │     │     ├── any gate in requiredGates has status 'failed' → continue
    │     │     └── no gate 'failed' → return { allowed: false, kind: 'fail', reason }
    │     │
    │     └── kind === 'auto' | undefined → skip kind check
    │
    ▼
{ allowed: true, kind, to, guard }
```

### 4.4 Workflow functions — mutation pattern

```
session: WorkflowSession, args...
    │
    ├── guard checks:     NOT performed (Engine's responsibility)
    ├── invariant checks: throw Error on violation
    │
    ▼
Mutate session fields directly:
    ├── session.activeOperation = { mutationId, startedAt, status }
    ├── session.approvals.push({ type: PLAN_APPROVAL_TYPE, callId, status, grantedAt })
    ├── setGateStatus(session, "invariants", "passed")
    └── bumpRetry(session, "cycles")
    │
    ▼
void (no return value)
```

---

## 5. Field Mapping Table (Parent → Plugin)

### 5.1 SessionFacts

| Parent `SessionFacts` field | Plugin `SessionFacts` field | Notes |
|---|---|---|
| `commitHash: string \| null` | `commitHash: string \| null` | Same. Empty string → null in `toSessionFacts()`. |
| `commitPermit: { callID: string } \| null` | `commitPermit: { allowed: boolean } \| null` | Plugin has boolean flag, not callID. `{ allowed: false }` → null. |
| `pendingPlanApproval: PendingPlanApproval \| null` | (no direct analog) | Plugin tracks approvals as `ApprovalStep[]` with `type: string`. |
| `planApproved: boolean` | `planApproved: boolean` | Plugin: `approvals.some(a => a.type === 'plan' && a.status === 'granted')`. |
| `tasks: PlanTask[]` | `tasks: PlanTask[]` | Different `PlanTask` shape (plugin has `assignedTo`, no `branch`/`manifest`). |
| `activeMutation: { agent: string } \| null` | `activeOperation: { mutationId: string; status: TaskStatus } \| null` | Plugin includes `status` field. |
| `testStatus: Record<string, GateStatus>` | `testStatus: TaskStatus` | Parent is per-task map; plugin is a single value. |
| `bugVerified: boolean` | `bugVerified: boolean` | Same. |
| `gates: Record<string, GateStatus>` | `gates: Record<string, GateStatus>` | Same flat structure. |
| `preset: 'low' \| 'medium' \| 'high'` | `profileId: string` | Renamed + different semantics. |

### 5.2 WorkflowSession fields (for workflow + dispatch functions)

| Parent `WorkflowSession` field | Plugin `WorkflowSession` field | Used by |
|---|---|---|
| `activeMutation: { callID, agent, startedAt, outputReady } \| null` | `activeOperation: { mutationId, startedAt, status, result? } \| null` | `beginMutation`, `finishMutation`, `isExpiredMutation`, `hasLiveVerifier`, `markOutputReady`, `clearActiveMutation` |
| `planApproved: boolean` | (derived from `approvals[]` by type) | `SessionFacts.planApproved` |
| `pendingPlanApproval: PendingPlanApproval \| null` | `approvals: ApprovalStep[]` | `approvePlan`, `declinePlan`, `toSessionFacts` |
| `planEvidence: string` | `evidence: string` parameter | `approvePlan` (parameter, not stored) |
| `consentedCallIDs: string[]` | (dedup by `callId` in `approvals[]`) | `approvePlan`, `declinePlan` |
| `gates: Gate[]` | `gates: Gate[]` | `setGateStatus`, `getGate`, `canCommit` |
| `retryBudgets: Record<string, RetryBudget>` | `retryBudgets: Record<string, RetryBudget>` | `bumpRetry`, `finishMutation` |
| `changedFiles: string[]` | `changedFiles: string[]` | `finishMutation` |
| `tasks: PlanTask[]` (status values: `active`, `committed`, etc.) | `tasks: PlanTask[]` (status values: `pending`, `running`, `completed`, `failed`, `skipped`) | `canCommit`, `getExecutionProgress`, `canExitExecution` |

### 5.3 Transition config

| Parent `Transition` | Plugin `Transition` | Notes |
|---|---|---|
| `from: PhaseId` | `from: string` | Same concept. |
| `to: PhaseId` | `to: string` | Same concept. |
| `guard?: string` | `guard?: string \| null` | Plugin explicitly allows `null`. |
| (no `kind` field) | `kind?: 'auto' \| 'pass' \| 'fail'` | Plugin uses `kind` inside `checkTransition()`: `'pass'` requires all gates passed, `'fail'` requires at least one gate failed. See AD7. |

---

## 6. Testing Strategy

### 6.1 Module-level unit tests

Each module has its own test file alongside source:

```
src/domain/
├── session-facts.test.ts
├── derive-phase.test.ts
├── validate-transition.test.ts
├── engine.test.ts
├── workflow.test.ts
└── dispatch.test.ts
```

### 6.2 `toSessionFacts` — mapping edge cases

| Test | Scenario | Expectation |
|------|----------|-------------|
| Full projection | Session with all fields populated | All 10 `SessionFacts` fields match spec mapping |
| Empty approvals | `approvals: []` | `planApproved: false`, `lastApproval: null` |
| No commit permit | `commitPermit: { allowed: false }` | `commitPermit: null` |
| Empty commit hash | `commitHash: ""` | `commitHash: null` |
| No active operation | `activeOperation: null` | `activeOperation: null` |
| Null active operation | `activeOperation: null` explicitly | `activeOperation: null` |
| One granted approval | `approvals: [{ status: "pending" }, { status: "granted" }]` | `planApproved: true` |
| No granted approval | `approvals: [{ status: "pending" }, { status: "denied" }]` | `planApproved: false` |
| Gates flattening | `gates: [{ id: "a", status: "passed" }, { id: "b", status: "running" }]` | `gates: { a: "passed", b: "running" }` |
| Empty gates array | `gates: []` | `gates: {}` (empty record) |

### 6.3 `derivePhase` — priority, matching, fallback, broken expressions

| Test | Scenario | Expectation |
|------|----------|-------------|
| Highest priority matches first | R100 condition true, R50 condition true | Returns R100 result |
| Low priority skips when high fails | R100 condition false, R50 condition true | Returns R50 result |
| No match — fallback to lowest priority | All conditions false, R0 has `true` | Returns R0 result (the fallback) |
| No match — no fallback (all conditions non-trivial false) | All conditions false, no `true` condition | Special case: return `"PLANNING"` |
| Empty rules array | `rules: []` | Returns `"PLANNING"` (default fallback) |
| Broken expression (runtime error) | `condition: "session.nonexistent.field == true"` | Safe-fail → skip to next rule |
| Expression accessing SessionFacts fields | `condition: "session.planApproved == true && session.gates.invariants == 'passed'"` | Correctly evaluates |
| Three-way priority | R100 false, R50 true, R0 true | Returns R50 (first match) |
| `bugVerified` rule | `condition: "session.bugVerified == true"` | Returns phase when `bugVerified: true` |

### 6.4 `checkTransition` — legal/illegal, guard pass/fail, kind semantics

| Test | Scenario | Expectation |
|------|----------|-------------|
| Valid transition without guard | Pair exists, no guard | Returns `{ allowed: true }` |
| Illegal transition | Pair not found | Returns `{ allowed: false, reason }` |
| Guarded transition passes | Pair exists, guard evaluates true | Returns `{ allowed: true }` |
| Guarded transition fails | Pair exists, guard evaluates false | Returns `{ allowed: false, reason }` |
| Guard without session (bypass) | Guard exists, no session provided | Returns `{ allowed: true }` (guard skipped) |
| Guard with gate lookup | Guard references `session.gates.*` | Properly evaluates |
| Empty transitions array | `transitions: []` | All pairs return `{ allowed: false }` |
| Guard expression null/empty | `guard: null` or `guard: ""` | Returns `{ allowed: true }` |
| Multiple transitions — correct pair selected | Array has multiple entries | Finds exact `from→to` match |
| kind=pass — all gates passed | kind=pass, all requiredGates have 'passed' | Returns `{ allowed: true, kind: 'pass' }` |
| kind=pass — gate pending | kind=pass, a requiredGate is 'pending' | Returns `{ allowed: false, kind: 'pass' }` |
| kind=pass — gate failed | kind=pass, a requiredGate is 'failed' | Returns `{ allowed: false, kind: 'pass' }` |
| kind=pass — empty requiredGates | kind=pass, requiredGates=[] | Returns `{ allowed: true, kind: 'pass' }` |
| kind=pass — no requiredGates | kind=pass, requiredGates undefined | Returns `{ allowed: true, kind: 'pass' }` |
| kind=fail — at least one gate failed | kind=fail, a requiredGate is 'failed' | Returns `{ allowed: true, kind: 'fail' }` |
| kind=fail — no gate failed | kind=fail, no requiredGate is 'failed' | Returns `{ allowed: false, kind: 'fail' }` |
| kind=auto bypasses gate checks | kind=auto, gates pending | Returns `{ allowed: true, kind: 'auto' }` |

### 6.5 `StateMachineEngine` — integration of all three methods

| Test | Scenario | Expectation |
|------|----------|-------------|
| derivePhase through engine | Engine with rules, session with approvals | Returns correct phase |
| canPerformAction — no guards | Empty `actionGuards` | Returns `{ allowed: true }` |
| canPerformAction — passing guard | All guards evaluate true | Returns `{ allowed: true }` |
| canPerformAction — failing guard | One guard evaluates false | Returns `{ allowed: false, reason }` |
| canPerformAction — first failure short-circuits | Multiple guards, first one fails | Returns failure, doesn't evaluate rest |
| checkTransition through engine | Engine with transitions | Same as pure function tests, returns `TransitionCheck` |
| checkTransition with session | Session provided, engine converts to facts internally | Correctly evaluates guard and injects `requiredGates` |
| checkTransition without session | No session parameter | Returns `{ allowed: true }` or `{ allowed: false }` |
| Engine with custom evaluateGuardFn | Mock always returns false | All guards fail, all actions blocked |

### 6.6 Workflow functions — happy path + error conditions

| Test | Scenario | Expectation |
|------|----------|-------------|
| `beginMutation` — fresh start | `activeOperation: null` | Sets new operation, resets `bugVerified`, resets invariants gate |
| `beginMutation` — replaces expired | Old operation past TTL | Replaces with new mutation |
| `beginMutation` — throws on active | Non-expired operation exists | Throws `Error` |
| `canCommit` — gates pass, tasks done | All required gates passed, tasks completed | Returns `true` |
| `canCommit` — gate pending | One gate not passed | Returns `false` |
| `canCommit` — tasks incomplete | Tasks not all completed | Returns `false` |
| `canCommit` — with manifest | `manifest` provided, uses `gateMapping` | Resolves gates from manifest |
| `approvePlan` — fresh approval | `approvals` empty | Appends `{ type: "plan", callId, status: "granted", grantedAt, evidence }` |
| `approvePlan` — same type+callId exists | Existing approval found | Updates `status`, `grantedAt`, `evidence` (update, not throw) |
| `declinePlan` — fresh decline | `approvals` empty | Appends `{ type: "plan", callId, status: "denied", evidence, feedback }` |
| `declinePlan` — same type+callId exists | Existing approval found | Updates `status` to `"denied"` and `feedback` (update, not throw) |
| `markBugVerified` | `bugVerified: false` | Sets `bugVerified: true` |
| `finishMutation` — passed | `passed: true` | Clears operation, sets invariants passed, stores changedFiles |
| `finishMutation` — failed | `passed: false` | Sets invariants failed, bumps retry |
| `parseWorkflowResult` — valid XML tag | Output has valid `<workflow-result>` | Returns parsed result |
| `parseWorkflowResult` — no tags | Plain text output | Returns `null` |
| `parseWorkflowResult` — last tag wins | Multiple tags, last one valid | Returns last valid result |
| `parseWorkflowResult` — malformed JSON | Invalid JSON inside tag | Skips to next tag |
| `isExpiredMutation` — within TTL | 5 min old | Returns `false` |
| `isExpiredMutation` — past TTL | 45 min old | Returns `true` |
| `isExpiredMutation` — null op | `activeOperation: null` | Returns `false` (nothing to expire — `beginMutation` creates a new operation) |
| `isExpiredMutation` — invalid date | `startedAt: "not-a-date"` | Returns `false` (can't determine — assume not expired) |
| `hasLiveVerifier` — active and running | Operation running | Returns `true` (no TTL check) |
| `hasLiveVerifier` — no active op | `activeOperation: null` | Returns `false` |
| `hasLiveVerifier` — completed | `status: "completed"` | Returns `false` |

### 6.7 Dispatch functions

| Test | Scenario | Expectation |
|------|----------|-------------|
| `markOutputReady` — callId matches | `mutationId === callId` | Sets `result = "output_ready"` |
| `markOutputReady` — callId mismatch | `mutationId !== callId` | No-op |
| `markOutputReady` — no active op | `activeOperation: null` | No-op, no error |
| `clearActiveMutation` — has operation | `activeOperation` non-null | Sets to `null` |
| `clearActiveMutation` — already null | `activeOperation: null` | No-op, no error |
| `getExecutionProgress` — mixed tasks | Some completed, some running | Correct counts |
| `getExecutionProgress` — all done | All completed, no active op | `{ completed, total, active: 0 }` |
| `getExecutionProgress` — active operation | Non-null `activeOperation` | `active: 1` |
| `canExitExecution` — done | No active op, all tasks completed | `true` |
| `canExitExecution` — active op exists | Non-null `activeOperation` | `false` |
| `canExitExecution` — tasks not done | Tasks not all completed | `false` |

---

## 7. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| **Empty `phaseAssignments` array** → no phase can be derived | Low | `derivePhase()` returns `"PLANNING"` as default fallback when rules array is empty. The Engine always produces a valid phase. |
| **Broken guard expression** in phase assignment rule or transition guard causes runtime error | Low | `evaluateGuard()` safe-fails on runtime errors by returning `false`. A broken condition acts as a non-match, and the next rule (or fallback) is used. The error is logged with a `[GuardEvaluator]` warning prefix for debugging. |
| **`ActiveOperation` has no TTL field** — `isExpiredMutation()` uses `startedAt` string comparison against `Date.now()` | Low | The function parses `startedAt` via `Date.parse()`. If parsing fails (invalid date format), the mutation is considered expired. This is consistent with the parent's approach. The 30-minute TTL is hardcoded as `MUTATION_TTL_MS`. |
| **No `pendingPlanApproval` analog** — plugin uses `ApprovalStep[]` array with derivation, not a separate field | Low | The plugin's model is simpler and more consistent. `planApproved` is always derived from `approvals.some(a => a.type === 'plan' && a.status === 'granted')`. Any existing tests or guards must reference `approvals`, not `pendingPlanApproval`. |
| **`canCommit()` imports `resolveConfig()` from Data Layer** — cross-layer dependency | Medium | This is intentional and follows the parent pattern (`workflow.ts` does the same). `canCommit()` needs the resolved config to determine which gates are required for the session's profile. This is the only workflow function with a cross-layer import. Workflow functions are inherently bound to the session and config layers. |
| **Config merge strategy undefined** — how `PhaseAssignmentRule[]` and `Transition[]` from multiple `ResolvedSchema` entries combine | Medium | MVP assumes a single merged array. The Application Layer (future change) must concatenate and deduplicate by `id`. The domain does not perform merging — it receives `EngineConfig` pre-merged. |
| **`parseWorkflowResult` regex matches across multiple blocks** — may match nested or malformed XML tags | Low | The regex `/<workflow-result>([\s\S]*?)<\/workflow-result>/gu` uses non-greedy `*?` and processes blocks last-to-first. The last-valid-block-wins strategy handles overlapping or malformed tags gracefully. |
| **`engine.canPerformAction` uses flat `string[]`** — all guards checked for any action, no per-action distinction | Low | Open question #3 from the proposal. Deferred to P1. For MVP, flat guards are sufficient. The spec already documents this limitation. |

---

## 8. Non-Goals (Scope Boundary Restatement)

The following are explicitly **NOT** in this MVP. They are listed here to prevent scope creep during design review:

| Component | Reason for exclusion | When |
|-----------|---------------------|------|
| **`deriveStage()`** | TUI-only display logic. The plugin has no TUI. | P1 Application Layer |
| **`entryGuards` / `exitGuards` on phase/stage definitions** | MVP only checks flat `actionGuards`. Phase-level guards are a richer model deferred to P1. | P1 |
| **Per-action `Record<ActionId, string>` guards** | MVP uses flat `string[]`. Per-action guards require schema expansion. | P1 |
| **Config merge logic** (combining `ResolvedSchema[]` into `EngineConfig`) | Application Layer responsibility. Domain receives pre-merged config. | Application Layer change |
| **Dispatch engine** (serial/parallel stage execution) | P1 feature. See `docs/layers.md`. | P1 |
| **Invariant checking** | Requires runtime file validation. | P1 |
| **Manifest presets** | Predefined stage sequences. | P1 |
| **Guardrails** (safety rules with severity levels) | P2 feature. | P2 |
| **Consent protocol** (structured operator consent flow) | P2 feature. | P2 |
| **Application Layer integration** (plugin runtime, dashboard, bridges) | Separate change after domain layer is verified. | Next change |
| **Config-driven rule compiler** (validates `PhaseAssignmentRule` at config-parse time) | MVP uses rules directly from resolved config. Compiler validates at config-parse time. | P1 |
