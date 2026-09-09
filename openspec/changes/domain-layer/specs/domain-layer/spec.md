## Purpose

Defines the Domain Layer — pure business logic for the session-guard plugin. The domain layer sits between the Data Layer (config loading, session persistence) and the Application Layer (plugin runtime, dashboard). It contains no I/O, no file access, and no plugin SDK dependencies. It receives resolved config objects and `SessionFacts` read-models, never raw `WorkflowSession`, except where pragmatically required (workflow orchestration functions that mutate session state directly).

## ADDED Requirements

### Requirement: R1: Domain types module (`src/domain/types.ts`) SHALL define shared type aliases and interfaces

The file SHALL export the following types:

| Export | Kind | Value |
|--------|------|-------|
| `PhaseId` | type alias | `string` |
| `ActionId` | type alias | `string` |
| `GateStatus` | type alias | `'pending' \| 'running' \| 'passed' \| 'failed' \| 'skipped'` |
| `ApprovalStatus` | type alias | `'pending' \| 'granted' \| 'denied'` |
| `TaskStatus` | type alias | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'skipped'` |
| `SessionFacts` | interface | See R2 |
| `PhaseTransitionResult` | interface | `{ allowed: boolean; reason?: string; nextPhase?: PhaseId }` |
| `WorkflowResult` | interface | `{ stage: string; status: 'pass' \| 'fail'; summary: string; evidence: string[] }` |
| `EngineConfig` | interface | See R4 |

The `GateStatus`, `ApprovalStatus`, and `TaskStatus` type aliases SHALL be equivalent to those in `src/session/types.ts` but defined independently in the domain for zero dependency on the session layer.

#### Scenario: Domain types are self-contained
- **GIVEN** a module that imports only from `src/domain/types.ts`
- **WHEN** the types are used
- **THEN** they resolve without importing from `src/session/types.ts` or any session-layer module

#### Scenario: PhaseTransitionResult allows phased transitions
- **GIVEN** `PhaseTransitionResult` with `{ allowed: true, nextPhase: 'EXECUTION' }`
- **WHEN** the result is read by the caller
- **THEN** `allowed` is `true` and `nextPhase` is `'EXECUTION'`

#### Scenario: PhaseTransitionResult with reason
- **GIVEN** `PhaseTransitionResult` with `{ allowed: false, reason: 'Transition guard failed: session.planApproved == true' }`
- **WHEN** the result is read by the caller
- **THEN** `allowed` is `false` and `reason` contains the failure explanation

---

### Requirement: R2: SessionFacts interface and `toSessionFacts()` SHALL project WorkflowSession into a domain-only read-model

`SessionFacts` interface SHALL be defined in `src/domain/session-facts.ts`.

#### R2.1: SessionFacts interface fields

```
interface SessionFacts {
  commitHash: string | null;
  commitPermit: { allowed: boolean } | null;
  approvals: Array<{ type: string; status: string }>;  // for granted(type) guard expressions
  lastApproval: ApprovalStep | null;
  tasks: { id: string; status: TaskStatus }[];
  activeOperation: { mutationId: string; startedAt: string; status: TaskStatus; result?: string } | null;
  testStatus: TaskStatus;
  bugVerified: boolean;
  gates: Record<string, GateStatus>;
  profileId: string;
}
```

| Field | Type | Source from WorkflowSession |
|-------|------|----------------------------|
| `commitHash` | `string \| null` | `session.commitHash` (empty string → `null`) |
| `commitPermit` | `{ allowed: boolean } \| null` | `session.commitPermit` (if `allowed` is `true`, emit the object; otherwise `null`) |
| `approvals` | `Array<{ type: string; status: string }>` | projected from `session.approvals` — only `type` and `status` preserved (for guard expressions like `granted('plan')`) |
| `lastApproval` | `ApprovalStep \| null` | last element of `session.approvals`, or `null` if empty |
| `tasks` | `{ id: string; status: TaskStatus }[]` | `session.tasks.map(t => ({ id: t.id, status: t.status }))` (only `id` and `status` projected, `title` and `assignedTo` are stripped) |
| `activeOperation` | `{ mutationId: string; startedAt: string; status: TaskStatus; result?: string } \| null` | `session.activeOperation` projected to `mutationId`, `startedAt`, `status`, `result?`; `null` when `session.activeOperation` is `null` |
| `testStatus` | `TaskStatus` | `session.testStatus` (direct pass-through) |
| `bugVerified` | `boolean` | `session.bugVerified` (direct pass-through) |
| `gates` | `Record<string, GateStatus>` | flattened from `session.gates: Gate[]` — keyed by gate `id`, value is gate `status` |
| `profileId` | `string` | `session.profileId` (direct pass-through) |

#### Scenario: toSessionFacts projects all fields
- **GIVEN** a `WorkflowSession` with `commitHash: "abc123"`, `commitPermit: { allowed: true }`, `approvals: [{ type: "plan", callId: "call-1", status: "granted" }]`, `gates: [{ id: "invariants", status: "passed" }, { id: "review", status: "pending" }]`, `activeOperation: { mutationId: "m-1", startedAt: "...", status: "running" }`, `testStatus: "pending"`, `bugVerified: false`, `tasks: [{ id: "t-1", title: "fix", status: "completed" }]`, `profileId: "android"`
- **WHEN** `toSessionFacts(session)` is called
- **THEN** it returns `SessionFacts` with:
  - `commitHash: "abc123"`
  - `commitPermit: { allowed: true }`
  - `approvals: [{ type: "plan", callId: "call-1", status: "granted" }]`
  - `lastApproval: { type: "plan", callId: "call-1", status: "granted" }`
  - `tasks: [{ id: "t-1", status: "completed" }]` (only `id` and `status` are projected; `title` is stripped)
  - `activeOperation: { mutationId: "m-1", startedAt: "...", status: "running" }`
  - `testStatus: "pending"`
  - `bugVerified: false`
  - `gates: { invariants: "passed", review: "pending" }`
  - `profileId: "android"`

#### Scenario: toSessionFacts with empty approvals
- **GIVEN** a `WorkflowSession` with `approvals: []`
- **WHEN** `toSessionFacts(session)` is called
- **THEN** `planApproved` is `false` and `lastApproval` is `null`

#### Scenario: toSessionFacts with no commit permit
- **GIVEN** a `WorkflowSession` with `commitPermit: { allowed: false }`
- **WHEN** `toSessionFacts(session)` is called
- **THEN** `commitPermit` is `null`

#### Scenario: toSessionFacts with empty commitHash
- **GIVEN** a `WorkflowSession` with `commitHash: ""`
- **WHEN** `toSessionFacts(session)` is called
- **THEN** `commitHash` is `null`

#### Scenario: toSessionFacts with null activeOperation
- **GIVEN** a `WorkflowSession` with `activeOperation: null`
- **WHEN** `toSessionFacts(session)` is called
- **THEN** `activeOperation` is `null`

#### Scenario: toSessionFacts projects approvals array
- **GIVEN** `session.approvals = [{ type: "plan", callId: "c1", status: "granted" }, { type: "commit", callId: "c2", status: "pending" }]`
- **WHEN** `toSessionFacts(session)` is called
- **THEN** `approvals` is `[{ type: "plan", status: "granted" }, { type: "commit", status: "pending" }]` (only `type` and `status` projected)

---

### Requirement: R3: `derivePhase()` SHALL compute the current phase from SessionFacts and PhaseAssignmentRule[]

Defined in `src/domain/derive-phase.ts`.

`derivePhase(facts: SessionFacts, rules: PhaseAssignmentRule[]): PhaseId`

#### R3.1: Rules are sorted by priority (descending) and evaluated in order

The function SHALL:
1. Sort `rules` by `priority` descending (highest priority first)
2. Iterate through sorted rules
3. For each rule, evaluate `rule.condition` as a JS expression via `evaluateGuard(rule.condition, facts, { granted: ... })` where `granted` is a closure checking `session.approvals` for `a.type === type && a.status === 'granted'`
4. On first truthy evaluation, return `rule.result`
5. If no rule matches, return the `result` of the lowest-priority rule (fallback)

The guard evaluator context is the `SessionFacts` object, accessed as `session` within the expression (matching `evaluateGuard`'s `session` parameter name). The `granted` function is available to all evaluation points:

```typescript
granted('plan')  // → true if any plan-type approval has status 'granted'
```

> **Note**: `evaluateGuard()` safe-fails on runtime errors by returning `false`, so a broken condition expression will not block phase derivation — it will act as a non-match and proceed to the next rule.

#### Scenario: Highest priority rule matches
- **GIVEN** rules `[{ id: "r1", priority: 100, condition: "session.planApproved == true", result: "EXECUTION" }, { id: "r2", priority: 50, condition: "true", result: "PLANNING" }]`
- **GIVEN** facts `{ planApproved: true }`
- **WHEN** `derivePhase(facts, rules)` is called
- **THEN** it returns `"EXECUTION"` (r1 matches first due to higher priority)

#### Scenario: No rule matches — fallback to lowest-priority rule's result
- **GIVEN** rules `[{ id: "r1", priority: 100, condition: "session.gates.invariants == 'passed'", result: "DONE" }, { id: "r2", priority: 0, condition: "true", result: "PLANNING" }]`
- **GIVEN** facts `{ gates: { invariants: "failed" } }`
- **WHEN** `derivePhase(facts, rules)` is called
- **THEN** it returns `"PLANNING"` (r2 is the fallback with `"true"` condition)

#### Scenario: Rule condition evaluates to false skips to next
- **GIVEN** rules `[{ id: "r1", priority: 100, condition: "session.bugVerified == true", result: "VERIFY" }, { id: "r2", priority: 50, condition: "session.planApproved == true", result: "EXECUTION" }]`
- **GIVEN** facts `{ bugVerified: false, planApproved: true }`
- **WHEN** `derivePhase(facts, rules)` is called
- **THEN** it returns `"EXECUTION"` (r1 skipped because condition is false)

#### Scenario: Rule with broken expression is skipped (evaluateGuard safe-fail)
- **GIVEN** rules `[{ id: "r1", priority: 100, condition: "session.nonexistent.field == true", result: "BROKEN" }, { id: "r2", priority: 50, condition: "true", result: "PLANNING" }]`
- **GIVEN** facts `{}`
- **WHEN** `derivePhase(facts, rules)` is called
- **THEN** it returns `"PLANNING"` (r1 throws during evaluation, evaluateGuard returns false, r2 matches)

#### Scenario: Empty rules array returns default phase
- **GIVEN** rules `[]`
- **WHEN** `derivePhase(facts, rules)` is called
- **THEN** it returns `"PLANNING"` (a default fallback phase, the first logical phase in a state machine)

> **Design note**: The default fallback when rules is empty is `"PLANNING"`. This aligns with the parent project's behavior where the first phase in `PHASES` is the initial state.

#### Scenario: planApproved mapped through gates
- **GIVEN** rule `{ id: "r1", priority: 100, condition: "session.planApproved == true && session.gates.invariants == 'passed'", result: "EXECUTION" }`
- **GIVEN** facts `{ planApproved: true, gates: { invariants: "passed" } }`
- **WHEN** `derivePhase(facts, rules)` is called
- **THEN** it returns `"EXECUTION"`

---

### Requirement: R4: `checkTransition()` SHALL check from→to pair in Transition[], evaluate optional guard, and check kind semantics

Defined in `src/domain/validate-transition.ts`.

```typescript
checkTransition(
  from: PhaseId,
  to: PhaseId,
  transitions: Transition[],
  session? : SessionFacts & { requiredGates? : string[] }
): TransitionCheck
```

Where:

```typescript
interface TransitionCheck {
  allowed: boolean;
  kind?: 'auto' | 'pass' | 'fail';
  reason?: string;
  to?: string;
  guard?: string | null;
}
```

### Requirement: R4.1: TransitionDef type SHALL define transition structure

The `TransitionDef` interface SHALL define the structure of a single phase transition:

```typescript
interface TransitionDef {
  from: string;                          // Source phase ID
  to: string;                            // Target phase ID
  guard?: string | null;                 // Optional guard expression
  kind?: 'auto' | 'pass' | 'fail';      // Transition kind hint
}
```

- `from` and `to` — required, non-empty strings identifying phases
- `guard` — optional guard expression; if null/empty, transition is always allowed; evaluated via GuardEvaluator
- `kind` — optional transition kind that controls validation semantics inside `checkTransition()`:
  - `'auto'` — no additional kind check; guard is the only gate (handled by `engine.autoProceed()`)
  - `'pass'` — transition allowed only if ALL `requiredGates` have status `"passed"`; otherwise blocked with `allowed: false, kind: 'pass'`
  - `'fail'` — transition allowed only if AT LEAST ONE `requiredGate` has status `"failed"`; otherwise blocked with `allowed: false, kind: 'fail'`

#### R4.1: Lookup and validation rules

1. Search `transitions` for an entry where `t.from === from && t.to === to`
2. If no matching entry is found, return `{ allowed: false, reason: "Illegal phase transition: {from} → {to}" }`
3. If a matching entry is found but has no `guard` (or `guard` is `null`/empty), skip guard check
4. If a matching entry has a `guard`:
   - If `session` is not provided, skip guard evaluation (allowed by default)
   - If `session` is provided, evaluate `evaluateGuard(transition.guard, session, {})`
   - If evaluation returns `false`, return `{ allowed: false, reason: "Transition guard failed for {from} → {to}: {guard}" }`
5. Evaluate `kind` semantics (if transition has `kind`):
   - If `kind === 'pass'`: check that EVERY gate ID in `requiredGates` has `session.gates[id] === 'passed'`. If any gate is not `'passed'`, return `{ allowed: false, kind: 'pass', reason: "Transition {from} → {to} (kind=pass) requires gates [...] to be 'passed', but they are not" }`
   - If `kind === 'fail'`: check that AT LEAST ONE gate ID in `requiredGates` has `session.gates[id] === 'failed'`. If none is `'failed'`, return `{ allowed: false, kind: 'fail', reason: "Transition {from} → {to} (kind=fail) requires at least one gate in [...] to be 'failed', but none are" }`
   - `kind === 'auto'` or any other value: no additional check
6. Return `{ allowed: true, kind: transition.kind, to: transition.to, guard }`

#### Scenario: Valid transition without guard
- **GIVEN** `transitions = [{ from: "PLANNING", to: "EXECUTION" }]`
- **WHEN** `checkTransition("PLANNING", "EXECUTION", transitions)` is called
- **THEN** it returns `{ allowed: true, kind: undefined, to: "EXECUTION", guard: null }`

#### Scenario: Illegal transition (pair not found)
- **GIVEN** `transitions = [{ from: "PLANNING", to: "EXECUTION" }]`
- **WHEN** `checkTransition("EXECUTION", "DONE", transitions)` is called
- **THEN** it returns `{ allowed: false, reason: "Illegal phase transition: EXECUTION → DONE" }`

#### Scenario: Guarded transition passes
- **GIVEN** `transitions = [{ from: "PLANNING", to: "EXECUTION", guard: "session.planApproved == true" }]`
- **GIVEN** `session = { planApproved: true }`
- **WHEN** `checkTransition("PLANNING", "EXECUTION", transitions, session)` is called
- **THEN** it returns `{ allowed: true, kind: undefined, to: "EXECUTION", guard: "session.planApproved == true" }`

#### Scenario: Guarded transition fails
- **GIVEN** `transitions = [{ from: "PLANNING", to: "EXECUTION", guard: "session.planApproved == true" }]`
- **GIVEN** `session = { planApproved: false }`
- **WHEN** `checkTransition("PLANNING", "EXECUTION", transitions, session)` is called
- **THEN** it returns `{ allowed: false, reason: "Transition guard failed for PLANNING → EXECUTION: session.planApproved == true" }`

#### Scenario: Guarded transition without session (bypass)
- **GIVEN** `transitions = [{ from: "PLANNING", to: "EXECUTION", guard: "session.planApproved == true" }]`
- **WHEN** `checkTransition("PLANNING", "EXECUTION", transitions)` is called (no session)
- **THEN** it returns `{ allowed: true, kind: undefined, to: "EXECUTION", guard: "session.planApproved == true" }` (guard evaluation skipped)

#### Scenario: Guard with gate lookup
- **GIVEN** `transitions = [{ from: "EXECUTION", to: "COMMIT", guard: "session.gates.invariants == 'passed'" }]`
- **GIVEN** `session = { gates: { invariants: "passed", review: "pending" } }`
- **WHEN** `checkTransition("EXECUTION", "COMMIT", transitions, session)` is called
- **THEN** it returns `{ allowed: true, kind: undefined, to: "COMMIT", guard: "session.gates.invariants == 'passed'" }`

#### Scenario: Empty transitions array rejects everything
- **GIVEN** `transitions = []`
- **WHEN** `checkTransition("PLANNING", "EXECUTION", transitions)` is called
- **THEN** it returns `{ allowed: false, reason: "Illegal phase transition: PLANNING → EXECUTION" }`

#### Scenario: kind=pass blocks when a required gate is not passed
- **GIVEN** `transitions = [{ from: "EXECUTION", to: "COMMIT", kind: "pass" }]`
- **GIVEN** `session = { gates: { invariants: "pending" }, requiredGates: ["invariants"] }`
- **WHEN** `checkTransition("EXECUTION", "COMMIT", transitions, session)` is called
- **THEN** it returns `{ allowed: false, kind: "pass", reason: <error mentioning invariants> }`

#### Scenario: kind=pass allows when all required gates are passed
- **GIVEN** `transitions = [{ from: "EXECUTION", to: "COMMIT", kind: "pass" }]`
- **GIVEN** `session = { gates: { invariants: "passed", review: "passed" }, requiredGates: ["invariants", "review"] }`
- **WHEN** `checkTransition("EXECUTION", "COMMIT", transitions, session)` is called
- **THEN** it returns `{ allowed: true, kind: "pass", to: "COMMIT" }`

#### Scenario: kind=fail blocks when no required gate is failed
- **GIVEN** `transitions = [{ from: "EXECUTION", to: "FIXUP", kind: "fail" }]`
- **GIVEN** `session = { gates: { invariants: "passed", review: "passed" }, requiredGates: ["invariants", "review"] }`
- **WHEN** `checkTransition("EXECUTION", "FIXUP", transitions, session)` is called
- **THEN** it returns `{ allowed: false, kind: "fail", reason: <error mentioning gate> }`

#### Scenario: kind=fail allows when at least one required gate is failed
- **GIVEN** `transitions = [{ from: "EXECUTION", to: "FIXUP", kind: "fail" }]`
- **GIVEN** `session = { gates: { invariants: "failed", review: "passed" }, requiredGates: ["invariants", "review"] }`
- **WHEN** `checkTransition("EXECUTION", "FIXUP", transitions, session)` is called
- **THEN** it returns `{ allowed: true, kind: "fail", to: "FIXUP" }`

#### Scenario: kind=auto bypasses pass/fail gate checks
- **GIVEN** `transitions = [{ from: "PLANNING", to: "EXECUTION", kind: "auto" }]`
- **GIVEN** `session = { gates: { invariants: "pending" }, requiredGates: ["invariants"] }`
- **WHEN** `checkTransition("PLANNING", "EXECUTION", transitions, session)` is called
- **THEN** it returns `{ allowed: true, kind: "auto", to: "EXECUTION" }`

#### Scenario: kind=pass with empty requiredGates allows
- **GIVEN** `transitions = [{ from: "EXECUTION", to: "COMMIT", kind: "pass" }]`
- **GIVEN** `session = { gates: {}, requiredGates: [] }`
- **WHEN** `checkTransition("EXECUTION", "COMMIT", transitions, session)` is called
- **THEN** it returns `{ allowed: true, kind: "pass", to: "COMMIT" }`

---

### Requirement: R5: The `SessionGuardEngine` class SHALL wrap config + guard evaluator

Defined in `src/domain/engine.ts`.

```typescript
class SessionGuardEngine {
  constructor(
    config: EngineConfig,
    evaluateGuardFn?: EvaluateGuardFn,
  )
  derivePhase(session: WorkflowSession): PhaseId
  canPerformAction(session: WorkflowSession, action: ActionId): { allowed: boolean; reason?: string }
  checkTransition(from: PhaseId, to: PhaseId, session?: WorkflowSession): TransitionCheck
}

export interface TransitionCheck {
  allowed: boolean;
  kind?: 'auto' | 'pass' | 'fail';
  reason?: string;
  to?: string;
  guard?: string | null;
}
```

#### R5.1: EngineConfig interface

```typescript
interface EngineConfig {
  phaseAssignments: PhaseAssignmentRule[];
  transitions: Transition[];
  actionGuards: string[];  // flat string[] — all evaluated for any action check (MVP scope)
  requiredGates?: string[]; // gate IDs used by kind=pass/fail validation; defaults to ['invariants']
}
```

The `actionGuards` field SHALL be a flat array of guard expressions. In MVP scope, all action guards are checked for any action (not per-action). `entryGuards`/`exitGuards` from phase definitions are NOT checked in MVP (deferred to P1 per D10).

The `requiredGates` field SHALL be an array of gate ID strings. It is consumed by `checkTransition()` when the transition has `kind: 'pass'` or `kind: 'fail'`. The Application Layer merges `requiredGates` from all schemas (last schema wins) and defaults to `['invariants']` if none is specified.

#### R5.2: `EvaluateGuardFn` type

```typescript
type EvaluateGuardFn = (expression: string, session: object, guards: GuardsExports) => boolean;
```

Defaults to the imported `evaluateGuard` from `src/guard-evaluator.ts` if not provided (allows test injection).

#### R5.3: Engine.derivePhase(session) behavior

1. Calls `toSessionFacts(session)` to produce `SessionFacts`
2. Delegates to `derivePhase(facts, this.config.phaseAssignments)` from the derive-phase module
3. Returns the resulting `PhaseId`

#### Scenario: Engine derives PLANNING phase
- **GIVEN** an engine constructed with config containing `phaseAssignments: [{ id: "always", priority: 0, condition: "true", result: "PLANNING" }]`
- **GIVEN** a `WorkflowSession` with no approvals
- **WHEN** `engine.derivePhase(session)` is called
- **THEN** it returns `"PLANNING"`

#### Scenario: Engine derives EXECUTION phase from session facts
- **GIVEN** an engine with `phaseAssignments: [{ id: "p1", priority: 100, condition: "session.planApproved == true", result: "EXECUTION" }, { id: "fallback", priority: 0, condition: "true", result: "PLANNING" }]`
- **GIVEN** a `WorkflowSession` with `approvals: [{ callId: "c1", status: "granted" }]`
- **WHEN** `engine.derivePhase(session)` is called
- **THEN** it returns `"EXECUTION"` (toSessionFacts derives planApproved=true, rule matches)

#### R5.4: Engine.canPerformAction(session, action) behavior

1. Calls `toSessionFacts(session)` to produce `SessionFacts`
2. Iterates over `this.config.actionGuards` (flat string array)
3. For each guard expression, evaluates via `evaluateGuard(guard, facts, {})`
4. If any guard evaluates to `false`, return `{ allowed: false, reason: "Action guard failed: {guard}" }`
5. If all guards pass (or there are no actionGuards), return `{ allowed: true }`

> **Design note**: In MVP, `actionGuards` is a flat `string[]` — ALL expressions are checked for ANY action. Per-action guards (`Record<ActionId, string>`) are deferred to P1 (Open Question #3 in proposal).

#### Scenario: canPerformAction with no guards
- **GIVEN** an engine with `config.actionGuards = []`
- **GIVEN** any session
- **WHEN** `engine.canPerformAction(session, "beginMutation")` is called
- **THEN** it returns `{ allowed: true }`

#### Scenario: canPerformAction with passing guard
- **GIVEN** an engine with `config.actionGuards = ["session.planApproved == true"]`
- **GIVEN** a session with `planApproved: true` (derived from approvals)
- **WHEN** `engine.canPerformAction(session, "beginMutation")` is called
- **THEN** it returns `{ allowed: true }`

#### Scenario: canPerformAction with failing guard
- **GIVEN** an engine with `config.actionGuards = ["session.planApproved == true"]`
- **GIVEN** a session with no approvals
- **WHEN** `engine.canPerformAction(session, "beginMutation")` is called
- **THEN** it returns `{ allowed: false, reason: "Action guard failed: session.planApproved == true" }`

#### Scenario: canPerformAction with multiple guards — first failure short-circuits
- **GIVEN** an engine with `config.actionGuards = ["session.bugVerified == true", "session.planApproved == true"]`
- **GIVEN** a session with `bugVerified: false, planApproved: true`
- **WHEN** `engine.canPerformAction(session, "markBugVerified")` is called
- **THEN** it returns `{ allowed: false, reason: "Action guard failed: session.bugVerified == true" }`

#### R5.5: Engine.checkTransition(from, to, session?) behavior

1. Calls `toSessionFacts(session)` if session is provided; passes `undefined` if session is absent
2. Injects `engine.config.requiredGates` into the session facts object
3. Delegates to `checkTransition(from, to, this.config.transitions, facts?)` from the validate-transition module
4. Returns the resulting `TransitionCheck` object

#### Scenario: Engine allows valid transition without guard
- **GIVEN** an engine with `transitions: [{ from: "PLANNING", to: "EXECUTION" }]`
- **WHEN** `engine.checkTransition("PLANNING", "EXECUTION")` is called
- **THEN** it returns `{ allowed: true, kind: undefined, to: "EXECUTION", guard: null }`

#### Scenario: Engine blocks illegal transition
- **GIVEN** an engine with `transitions: [{ from: "PLANNING", to: "EXECUTION" }]`
- **WHEN** `engine.checkTransition("PLANNING", "COMMIT")` is called
- **THEN** it returns `{ allowed: false, reason: "Illegal phase transition: PLANNING → COMMIT" }`

#### R5.6: Constructor behavior with optional evaluateGuardFn

- If `evaluateGuardFn` is provided, the engine SHALL use it instead of the default `evaluateGuard` import
- This enables test injection of a mock guard evaluator

#### Scenario: Engine with custom evaluateGuardFn
- **GIVEN** a custom `evaluateGuardFn` that always returns `false`
- **GIVEN** an engine with `actionGuards: ["true"]`
- **WHEN** `engine.canPerformAction(session, "anyAction")` is called
- **THEN** it returns `{ allowed: false, reason: "Action guard failed: true" }`

---

### Requirement: R6: Workflow functions SHALL mutate WorkflowSession directly

Defined in `src/domain/workflow.ts`.

All functions accept `WorkflowSession` as the first parameter (or second where noted) and mutate it in-place. They SHALL use `setGateStatus()`, `bumpRetry()`, and other helpers from `src/session/session-schema.ts` for gate and retry mutations.

#### R6.1: `beginMutation(session: WorkflowSession, mutationId: string): void`

Starts a new mutation operation on the session.

Preconditions (caller's responsibility — engine checks guards before calling this):
- `session.activeOperation` is `null` (or expired — handled by function)
- No guard checks are performed inside the function (D4, Open Question #4)

Behavior:
1. If `session.activeOperation` is not `null` and is NOT expired (via `isExpiredMutation()`), throw `Error("Active operation already exists: {mutationId}")`
2. Set `session.activeOperation = { mutationId, startedAt: <current ISO timestamp>, status: "running" }`
3. Set `session.bugVerified = false`
4. Call `setGateStatus(session, "invariants", "pending")` to reset the invariants gate

> **Note**: The function takes `mutationId` as a string identifier, not a `callId` + `agent` tuple. The `agent` parameter was removed because the plugin's `ActiveOperation` has no agent field — agent tracking is the Engine/Application Layer's responsibility.

**Note**: The parent `beginMutation()` checks retry exhaustion and plan approval guards. Those checks are now the Engine's responsibility (per D4/Q4). The domain function is a thin mutator.

#### Scenario: beginMutation sets active operation
- **GIVEN** a session with `activeOperation: null`, `bugVerified: true`, `gates: [{ id: "invariants", status: "passed" }]`
- **WHEN** `beginMutation(session, "mutation-1")` is called
- **THEN** `session.activeOperation` equals `{ mutationId: "mutation-1", status: "running", startedAt: <ISO string> }`
- **THEN** `session.bugVerified` is `false`
- **THEN** gate `invariants` status is `"pending"`

#### Scenario: beginMutation throws when active operation exists and is not expired
- **GIVEN** a session with `activeOperation: { mutationId: "existing", startedAt: <1 min ago>, status: "running" }`
- **WHEN** `beginMutation(session, "new-mutation")` is called
- **THEN** it throws `Error("Active operation already exists: existing")`

#### Scenario: beginMutation replaces expired active operation
- **GIVEN** a session with `activeOperation: { mutationId: "stale", startedAt: <45 min ago>, status: "running" }`
- **WHEN** `beginMutation(session, "new-mutation")` is called
- **THEN** `session.activeOperation` is set to the new mutation (old one is replaced)

#### R6.2: `canCommit(session: WorkflowSession, requiredGates: string[]): boolean`

Determines if the session is ready to commit changes. A pure function that receives pre-resolved gate IDs directly — unlike the parent project, it does NOT call `resolveConfig` internally.

Behavior:
1. For each gate ID in `requiredGates`:
   - Find the gate in `session.gates` by ID
   - If the gate does not exist, return `false`
   - If the gate exists but its `status` is not `"passed"`, return `false`
2. Check that all tasks in `session.tasks` have `status === "completed"`
3. Return `true` only if both conditions are met

> **Design note**: The plugin's `canCommit` is simplified from the parent. It takes pre-resolved gate IDs directly instead of resolving config internally. The caller (Application Layer) is responsible for determining which gates are required based on the session's profile and any relevant manifest.

#### Scenario: canCommit returns true when all gates pass and tasks done
- **GIVEN** `session.gates = [{ id: "invariants", status: "passed" }, { id: "review", status: "passed" }]`, `session.tasks = [{ id: "t1", status: "completed" }]`
- **WHEN** `canCommit(session, ["invariants", "review"])` is called
- **THEN** it returns `true`

#### Scenario: canCommit returns false when a gate is pending
- **GIVEN** `session.gates = [{ id: "invariants", status: "passed" }, { id: "review", status: "pending" }]`
- **WHEN** `canCommit(session, ["invariants", "review"])` is called
- **THEN** it returns `false`

#### Scenario: canCommit returns false when tasks are incomplete
- **GIVEN** all gates passed, but `session.tasks = [{ id: "t1", status: "running" }]`
- **WHEN** `canCommit(session, ["invariants"])` is called
- **THEN** it returns `false`

#### Scenario: canCommit returns false when a required gate does not exist
- **GIVEN** `session.gates = [{ id: "invariants", status: "passed" }]`
- **WHEN** `canCommit(session, ["nonexistent"])` is called
- **THEN** it returns `false`

#### R6.3: `approvePlan(session: WorkflowSession, evidence: string, callId: string): void`

Records a plan approval with type `'plan'`. The `evidence` parameter is a cryptographic digest (e.g., sha256) of the approved plan content, used for later tamper detection.

Behavior:
1. Search `session.approvals` for entry where `a.type === PLAN_APPROVAL_TYPE && a.callId === callId`
2. If found, update `status` to `"granted"`, set `grantedAt`, and update `evidence`
3. If not found, append `{ type: PLAN_APPROVAL_TYPE, callId, status: "granted", grantedAt: <ISO timestamp>, evidence }`
4. The constant `PLAN_APPROVAL_TYPE = 'plan'` is defined in `workflow.ts`

#### Scenario: approvePlan adds approval record with evidence
- **GIVEN** `session.approvals = []`
- **WHEN** `approvePlan(session, "sha256:abc123", "call-1")` is called
- **THEN** `session.approvals` contains `{ type: "plan", callId: "call-1", status: "granted", grantedAt: <ISO string>, evidence: "sha256:abc123" }`

#### Scenario: approvePlan updates existing approval for same type+callId
- **GIVEN** `session.approvals = [{ type: "plan", callId: "call-1", status: "pending" }]`
- **WHEN** `approvePlan(session, "sha256:newhash", "call-1")` is called
- **THEN** `session.approvals[0].status` is `"granted"` and `session.approvals[0].evidence` is `"sha256:newhash"`

> **Design note**: `approvePlan` updates rather than throws on duplicate, because the same plan can be re-approved after being re-presented (e.g., if content changed). The `evidence` field stores the plan digest at the time of approval, enabling Application Layer to detect tampering. The `planApproved` boolean is DERIVED in `toSessionFacts()` from `approvals.some(a => a.type === PLAN_APPROVAL_TYPE && a.status === 'granted')`.

#### R6.4: `declinePlan(session: WorkflowSession, evidence: string, callId: string, feedback: string): void`

Records a plan rejection with type `'plan'`. The `evidence` parameter is the plan digest at the time of rejection. The `feedback` string is the reason for rejection provided by the operator.

Behavior:
1. Search `session.approvals` for entry where `a.type === PLAN_APPROVAL_TYPE && a.callId === callId`
2. If found, update `status` to `"denied"`, set `evidence`, and set `feedback` — both the plan digest and the rejection reason are updated on re-decline
3. If not found, append `{ type: PLAN_APPROVAL_TYPE, callId, status: "denied", evidence, feedback }`

#### Scenario: declinePlan adds denial record with evidence and feedback
- **GIVEN** `session.approvals = []`
- **WHEN** `declinePlan(session, "sha256:abc123", "call-2", "Missing test cases")` is called
- **THEN** `session.approvals` contains `{ type: "plan", callId: "call-2", status: "denied", evidence: "sha256:abc123", feedback: "Missing test cases" }`

#### R6.5: `markBugVerified(session: WorkflowSession): void`

Sets `session.bugVerified = true`.

#### Scenario: markBugVerified sets flag
- **GIVEN** `session.bugVerified = false`
- **WHEN** `markBugVerified(session)` is called
- **THEN** `session.bugVerified` is `true`

#### R6.6: `finishMutation(session: WorkflowSession, passed: boolean, changedFiles: string[]): void`

Completes the current mutation operation.

Behavior:
1. Set `session.changedFiles = changedFiles`
2. Set `session.activeOperation = null` (clear active operation)
3. Set gate `invariants` status to `"passed"` if `passed` is `true`, else `"failed"`
4. If not `passed`, call `bumpRetry(session, "cycles")`

#### Scenario: finishMutation with passed=true
- **GIVEN** `session.activeOperation = { mutationId: "m-1", status: "running" }`, `session.changedFiles = []`
- **WHEN** `finishMutation(session, true, ["src/foo.ts"])` is called
- **THEN** `session.activeOperation` is `null`
- **THEN** `session.changedFiles` equals `["src/foo.ts"]`
- **THEN** gate `invariants` status is `"passed"`

#### Scenario: finishMutation with passed=false bumps retry
- **GIVEN** `session.activeOperation = { mutationId: "m-1", status: "running" }`, `session.retryBudgets = { cycles: { attempts: 0, maximum: 3 } }`
- **WHEN** `finishMutation(session, false, [])` is called
- **THEN** gate `invariants` status is `"failed"`
- **THEN** `session.retryBudgets.cycles.attempts` equals `1`

#### R6.7: `parseWorkflowResult(output: string): WorkflowResult | null`

Parses `<workflow-result>` XML tags from an LLM output string.

Behavior:
1. Find all `<workflow-result>...</workflow-result>` blocks via regex
2. Iterate blocks from last to first (last-wins)
3. Try to `JSON.parse` each block's content
4. Validate parsed object has (via `isValidWorkflowResult()`):
   - `stage` is a `string` (any value — no enum restriction; the WorkflowResult type accepts a free string)
   - `status` in `["pass", "fail"]`
   - `summary` is a non-empty string
   - `evidence` is a non-empty array of non-empty strings
5. Return the last valid result; return `null` if none found

> **Design note**: The parent restricts `stage` to `"review" | "qa" | "verify_bug"`. The plugin accepts any string, matching `WorkflowResult.stage: string`. The calling code (Application Layer) applies its own validation. The `isValidWorkflowResult()` helper is a private function that checks shape only, leaving semantics to the caller.

#### Scenario: parseWorkflowResult finds valid tag
- **GIVEN** output `"Some text <workflow-result>{\"stage\":\"review\",\"status\":\"pass\",\"summary\":\"LGTM\",\"evidence\":[\"log-1\"]}</workflow-result> more text"`
- **WHEN** `parseWorkflowResult(output)` is called
- **THEN** it returns `{ stage: "review", status: "pass", summary: "LGTM", evidence: ["log-1"] }`

#### Scenario: parseWorkflowResult returns null for no tags
- **GIVEN** output `"Just some text"`
- **WHEN** `parseWorkflowResult(output)` is called
- **THEN** it returns `null`

#### Scenario: parseWorkflowResult picks last valid tag
- **GIVEN** output with two tags — first invalid (missing evidence), second valid
- **WHEN** `parseWorkflowResult(output)` is called
- **THEN** it returns the second (valid) result

#### Scenario: parseWorkflowResult ignores malformed JSON
- **GIVEN** output `<workflow-result>{invalid json}</workflow-result>`
- **WHEN** `parseWorkflowResult(output)` is called
- **THEN** it returns `null`

#### R6.8: `isExpiredMutation(session: WorkflowSession): boolean`

Checks if the session's active operation has expired (TTL = 30 minutes, constant `MUTATION_TTL_MS`).

Behavior:
1. If `session.activeOperation` is `null`, return `false` (no active operation to expire)
2. Parse `session.activeOperation.startedAt` via `Date.parse()`
3. If `Date.parse()` returns `NaN`, return `false` (can't determine — assume not expired)
4. Return `true` if `Date.now() - startTime >= MUTATION_TTL_MS`, else `false`

> **Design note**: The parent returns `true` for `null` and invalid dates. The plugin returns `false` in both cases — a missing or unparseable active operation means there is nothing to expire. This is safer: `beginMutation` will proceed to create a new operation rather than throwing about an "expired" non-existent operation.

#### Scenario: Mutation within TTL is not expired
- **GIVEN** a session with `activeOperation: { startedAt: <5 min ago> }`
- **WHEN** `isExpiredMutation(session)` is called
- **THEN** it returns `false`

#### Scenario: Mutation past TTL is expired
- **GIVEN** a session with `activeOperation: { startedAt: <45 min ago> }`
- **WHEN** `isExpiredMutation(session)` is called
- **THEN** it returns `true`

#### Scenario: No active operation is NOT expired (returns false)
- **GIVEN** a session with `activeOperation: null`
- **WHEN** `isExpiredMutation(session)` is called
- **THEN** it returns `false` (there is nothing to expire — `beginMutation` will create a new operation)

#### Scenario: Invalid date string is NOT expired (returns false)
- **GIVEN** a session with `activeOperation: { startedAt: "not-a-date" }`
- **WHEN** `isExpiredMutation(session)` is called
- **THEN** it returns `false` (cannot determine expiration — assume not expired)

#### R6.9: `hasLiveVerifier(session: WorkflowSession, agent: string): boolean`

Checks if the session has a running active operation. Simplified from the parent — no TTL check, no agent matching.

Behavior:
1. If `session.activeOperation` is `null`, return `false`
2. If `session.activeOperation.status === 'running'`, return `true`
3. Otherwise return `false`

> **Design note**: The parent `hasLiveVerifier()` checks TTL and agent match. The plugin version is simpler — it only checks if an active operation with `status: 'running'` exists. TTL check and agent matching are deferred to the Engine/Application Layer. The `agent` parameter is accepted for API compatibility but NOT checked.

#### Scenario: hasLiveVerifier returns true when active and running
- **GIVEN** `session.activeOperation = { mutationId: "m-1", startedAt: "...", status: "running" }`
- **WHEN** `hasLiveVerifier(session, "review")` is called
- **THEN** it returns `true` (regardless of the agent value)

#### Scenario: hasLiveVerifier returns false when no active operation
- **GIVEN** `session.activeOperation = null`
- **WHEN** `hasLiveVerifier(session, "review")` is called
- **THEN** it returns `false`

#### Scenario: hasLiveVerifier returns false when active operation is not running
- **GIVEN** `session.activeOperation = { mutationId: "m-1", startedAt: "...", status: "completed" }`
- **WHEN** `hasLiveVerifier(session, "review")` is called
- **THEN** it returns `false`

---

### Requirement: R7: Dispatch functions SHALL manage execution lifecycle on WorkflowSession

Defined in `src/domain/dispatch.ts`.

#### R7.1: `markOutputReady(mutationId: string, session: WorkflowSession): void`

Marks the active operation's output as ready, if the `mutationId` matches.

Behavior:
1. If `session.activeOperation` is `null`, do nothing (no-op)
2. If `session.activeOperation.mutationId !== mutationId`, do nothing (no-op for mismatched mutationId)
3. Otherwise, set `session.activeOperation.result = "output_ready"`

> **Design note**: The parent `markOutputReady()` sets `session.activeMutation.outputReady = true`. The plugin stores this as `session.activeOperation.result = "output_ready"` because `ActiveOperation` has a `result?: string` field instead of a dedicated `outputReady` boolean.

#### Scenario: markOutputReady sets result when callId matches
- **GIVEN** `session.activeOperation = { mutationId: "m-1", startedAt: "...", status: "running" }`
- **WHEN** `markOutputReady("m-1", session)` is called
- **THEN** `session.activeOperation.result` equals `"output_ready"`

#### Scenario: markOutputReady is no-op when callId does not match
- **GIVEN** `session.activeOperation = { mutationId: "m-1", startedAt: "...", status: "running" }`
- **WHEN** `markOutputReady("different-id", session)` is called
- **THEN** `session.activeOperation.result` remains undefined

#### Scenario: markOutputReady is no-op when no active operation
- **GIVEN** `session.activeOperation = null`
- **WHEN** `markOutputReady("m-1", session)` is called
- **THEN** no error is thrown and session remains unchanged

#### R7.2: `clearActiveMutation(session: WorkflowSession): void`

Clears the active operation. Sets `session.activeOperation = null`.

#### Scenario: clearActiveMutation clears operation
- **GIVEN** `session.activeOperation = { mutationId: "m-1", startedAt: "...", status: "running" }`
- **WHEN** `clearActiveMutation(session)` is called
- **THEN** `session.activeOperation` is `null`

#### Scenario: clearActiveMutation when already null
- **GIVEN** `session.activeOperation = null`
- **WHEN** `clearActiveMutation(session)` is called
- **THEN** no error is thrown and session stays unchanged

#### R7.3: `getExecutionProgress(session: WorkflowSession): { completed: number; total: number; active: number }`

Returns execution progress counts.

Behavior:
- `completed`: count of tasks where `task.status === "completed"`
- `total`: `session.tasks.length`
- `active`: `1` if `session.activeOperation !== null`, else `0`

#### Scenario: getExecutionProgress with mixed tasks
- **GIVEN** `session.tasks = [{ id: "t1", status: "completed" }, { id: "t2", status: "running" }]`, `session.activeOperation = { mutationId: "m-1", ... }`
- **WHEN** `getExecutionProgress(session)` is called
- **THEN** it returns `{ completed: 1, total: 2, active: 1 }`

#### Scenario: getExecutionProgress with all done
- **GIVEN** `session.tasks = [{ id: "t1", status: "completed" }]`, `session.activeOperation = null`
- **WHEN** `getExecutionProgress(session)` is called
- **THEN** it returns `{ completed: 1, total: 1, active: 0 }`

#### R7.4: `canExitExecution(session: WorkflowSession): boolean`

Checks if execution phase can exit.

Behavior:
1. Return `true` if `session.activeOperation === null` AND all tasks have `status === "completed"`
2. Otherwise, return `false`

#### Scenario: canExitExecution returns true when done
- **GIVEN** `session.activeOperation = null`, `session.tasks = [{ id: "t1", status: "completed" }]`
- **WHEN** `canExitExecution(session)` is called
- **THEN** it returns `true`

#### Scenario: canExitExecution returns false when active operation exists
- **GIVEN** `session.activeOperation = { mutationId: "m-1", ... }`, `session.tasks = [{ id: "t1", status: "completed" }]`
- **WHEN** `canExitExecution(session)` is called
- **THEN** it returns `false`

#### Scenario: canExitExecution returns false when tasks not done
- **GIVEN** `session.activeOperation = null`, `session.tasks = [{ id: "t1", status: "running" }]`
- **WHEN** `canExitExecution(session)` is called
- **THEN** it returns `false`

---

### Requirement: R8: Barrel export file SHALL re-export all domain symbols

Defined in `src/domain/index.ts`.

SHALL re-export from:
- `./types.ts` — all types (PhaseId, ActionId, GateStatus, ApprovalStatus, TaskStatus, SessionFacts, PhaseTransitionResult, WorkflowResult, EngineConfig)
- `./session-facts.ts` — `toSessionFacts` function
- `./derive-phase.ts` — `derivePhase` function
- `./validate-transition.ts` — `checkTransition` function
- `./engine.ts` — `SessionGuardEngine` class and `EvaluateGuardFn` type
- `./workflow.ts` — all workflow functions
- `./dispatch.ts` — all dispatch functions

#### Scenario: Barrel re-exports all domain symbols
- **GIVEN** `import * as Domain from './domain/index.ts'`
- **WHEN** inspecting exports
- **THEN** `Domain.SessionGuardEngine` is available
- **THEN** `Domain.derivePhase` is available
- **THEN** `Domain.checkTransition` is available
- **THEN** `Domain.toSessionFacts` is available
- **THEN** `Domain.canCommit` is available
- **THEN** `Domain.beginMutation` is available
- **THEN** `Domain.markOutputReady` is available
- **THEN** `Domain.SessionFacts` (type) is exported
- **THEN** `Domain.EngineConfig` (type) is exported

---

### Requirement: R9: Main index.ts SHALL re-export new domain symbols

The existing `src/index.ts` SHALL add a domain section that re-exports all domain symbols from `src/domain/index.ts`.

#### Scenario: Domain symbols are accessible from main entry
- **GIVEN** `import { SessionGuardEngine, derivePhase, toSessionFacts } from './src/index.ts'`
- **WHEN** resolving the imports
- **THEN** they resolve without error
- **THEN** they refer to the implementations in `src/domain/`

---

## Non-Goals (MVP Scope Boundary)

The following are explicitly NOT covered by this specification:

| Feature | Reason |
|---------|--------|
| `entryGuards` / `exitGuards` on phase or stage definitions | Deferred to P1 (D10). Only flat `actionGuards` are checked. |
| Per-action `Record<ActionId, string>` guards | MVP uses flat `string[]`. Per-action guards deferred to P1 (Open Question #3). |
| `deriveStage()` for TUI display | Not applicable — plugin has no TUI. Deferred to Application Layer. |
| Dispatch engine (serial/parallel stage execution) | P1 feature. See `docs/layers.md`. |
| Invariant checking | P1. Requires runtime file validation. |
| Manifest presets | P1. Predefined stage sequences. |
| Guardrails | P2. Safety rules with severity levels. |
| Consent protocol | P2. Structured operator consent flow. |
| Config merge logic (combining multiple ResolvedSchema) | Application Layer responsibility (D8). Domain receives pre-merged `EngineConfig`. |
| Application Layer integration | Separate change. This spec covers only the pure Domain Layer. |
