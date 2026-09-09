# profile-schemas Specification

## Purpose

Defines the profile schema files — YAML documents that describe state machine structure. Each profile may provide one or more schemas listed in its `profile.json` `schemas` field. Schemas define phases, transitions, gate mapping, settings, phase assignments, and profile agents/guards.

Schema files are validated against a Zod schema at load time and support `extends` to inherit from schemas in the extended profile chain.

All guard, condition, and expression fields (`guard`, `entryGuards`, `exitGuards`, `actionGuards` values, `phaseAssignments[].condition`) use **JavaScript-like expression syntax**. Expressions are evaluated at runtime with access to:
- `session` — the current session context
- Custom guard functions — exports from `guards.ts` in the profile directory (see profile-loader spec)

## ADDED Requirements

### Requirement: Schema SHALL support extends field

Each YAML schema SHALL support an optional `extends` field referencing another schema. The reference format SHALL be `<profile-id>/<schema-filename>` (e.g., `"base/session-guard.yaml"`). When present, the resolver SHALL load the referenced schema from the extended profile and merge its fields as the base. When absent, the schema is standalone.

Circular extends SHALL be detected and handled by the **first-encounter wins** rule.

#### Scenario: Schema extends another schema
- **WHEN** schema file contains `extends: "base/session-guard.yaml"`
- **THEN** the resolver loads `profiles/base/session-guard.yaml` as the base before applying overrides

#### Scenario: Schema without extends is standalone
- **WHEN** schema has no `extends` field
- **THEN** the schema is resolved from its own fields alone

### Requirement: Schema SHALL support phases definitions

The schema SHALL support an optional `phases` object defining state machine phases. Each key is a phase id (e.g., `PLANNING`, `EXECUTION`), each value is a phase definition object. When the schema has `extends`, the profile's phases SHALL replace the base phases.

A phase definition MAY contain:
- `dispatch` — dispatch strategy for the phase (strategy, maxConcurrent, overlapRoles)
- `stages` — ordered list of stages within the phase, each with allowedAgents, entryGuards, exitGuards

#### Scenario: Schema defines phases
- **WHEN** schema specifies `phases: { PLANNING: {}, EXECUTION: { dispatch: { strategy: "serial_with_overlap", maxConcurrent: 2 } } }`
- **THEN** these phases are available in the resolved config

#### Scenario: Schema with extends replaces base phases
- **WHEN** schema extends `"base/session-guard.yaml"` and specifies its own `phases`
- **THEN** the base phases are fully replaced by the extending schema's phases

### Requirement: Schema SHALL support transitions list

The schema SHALL support an optional `transitions` array defining allowed state transitions. Each transition SHALL have `from`, `to`, and MAY have `guard` (expression string) and `kind` (defaults to `"auto"`).

#### Scenario: Schema defines transitions
- **WHEN** schema specifies `transitions: [{ from: "PLANNING", to: "EXECUTION", guard: "session.planApproved == true" }]`
- **THEN** these transitions are available in the resolved config

#### Scenario: Schema with extends inherits base transitions
- **WHEN** schema extends another schema and does not specify `transitions`
- **THEN** the base transitions are inherited

#### Scenario: Schema with extends overrides base transitions
- **WHEN** schema extends another schema and specifies `transitions`
- **THEN** the profile's transitions fully replace the base transitions

### Requirement: Schema SHALL support gateMapping

The schema SHALL support an optional `gateMapping` object mapping stage ids to gate id arrays. When the schema has `extends` and `gateMapping` is present, it SHALL fully replace the base `gateMapping`. When absent, the base `gateMapping` SHALL be inherited.

#### Scenario: Schema defines gateMapping
- **WHEN** schema specifies `gateMapping: { review: ["invariants", "review"] }`
- **THEN** the gate mapping is available in the resolved config

#### Scenario: Schema inherits gateMapping from extends
- **WHEN** schema extends another schema and does not specify `gateMapping`
- **THEN** the base `gateMapping` is inherited

### Requirement: Schema SHALL support settings

The schema SHALL support an optional `settings` object for runtime configuration (stall thresholds, timeouts, retry limits, default agents, etc.). When the schema has `extends`, settings SHALL be deep-merged — profile values override base values by key.

#### Scenario: Schema overrides a subset of settings
- **WHEN** profile specifies `settings: { mutationTtlMs: 600000 }` while the base has `{ mutationTtlMs: 1800000, retryMaxAttempts: 3 }`
- **THEN** the resulting merged settings has `mutationTtlMs: 600000` (overridden) and `retryMaxAttempts: 3` (inherited)

### Requirement: Schema SHALL support phaseAssignments (derive phase rules)

The schema SHALL support an optional `phaseAssignments` array. Each rule SHALL have `id`, `priority`, `condition`, and `result`. When the schema has `extends`, rules with the same `id` SHALL replace the base rule; rules with new `id` values SHALL be appended.

#### Scenario: Schema replaces a base derivePhaseRule
- **WHEN** schema specifies `phaseAssignments` with an `id` matching a base rule
- **THEN** the base rule with that `id` is replaced by the extending schema's version

#### Scenario: Schema adds a new derivePhaseRule
- **WHEN** schema specifies `phaseAssignments` with an `id` not present in base
- **THEN** the new rule is appended to the rule set with its declared priority

### Requirement: Schema SHALL support editingAgents, verifiers, requiredGates, actionGuards

The schema SHALL support optional fields for agent and guard configuration:
- `editingAgents` — agents that can write code
- `verifiers` — agents that verify output
- `requiredGates` — gates required even without a manifest (analogous to `mandatoryStages`)
- `actionGuards` — guard expressions keyed by action id

Each field, when present and the schema has `extends`, SHALL fully replace the base value.

#### Scenario: Schema defines editingAgents
- **WHEN** schema specifies `editingAgents: ["code", "architect"]`
- **THEN** the editing agents are available in the resolved config

#### Scenario: Schema defines actionGuards
- **WHEN** schema specifies `actionGuards: { beginMutation: "session.planApproved == true" }`
- **THEN** the action guard is evaluated when the corresponding action is checked

### Requirement: Guard/condition expressions SHALL use JS-like syntax

All string fields containing conditions (`guard`, `entryGuards`, `exitGuards`, `actionGuards` values, `phaseAssignments[].condition`) SHALL use JavaScript-like expression syntax compiled via the guard evaluator.

The guard evaluator SHALL provide access to:
- `session` — the session context object
- Custom functions — every export from the profile's `guards.ts` file

#### Scenario: Guard expression with session access
- **WHEN** schema specifies `guard: "session.gates.find(g => g.id === 'invariants')?.status === 'passed'"`
- **THEN** the expression is compiled and evaluated against the session context

#### Scenario: Guard expression calls custom function
- **WHEN** `guards.ts` exports `isInvariantsPass(session)` and schema specifies `guard: "isInvariantsPass(session)"`
- **THEN** the guard evaluator resolves the function name from the guards context and invokes it

#### Scenario: Multiple exitGuards with logical operators
- **WHEN** schema specifies `exitGuards: ["session.activeMutation?.outputReady == true", "session.testStatus[taskId] == 'pass'"]`
- **THEN** all guards SHALL evaluate to truthy for the stage to exit

#### Scenario: actionGuards with guard expressions
- **WHEN** schema specifies `actionGuards: { beginMutation: "session.planApproved == true" }`
- **THEN** the expression is evaluated when the corresponding action is checked

### Requirement: Profile SHALL support optional guards.ts

The profile directory MAY contain a `guards.ts` file exporting helper functions for use in guard expressions. Each exported function name becomes available as a callable identifier in all guard/condition expressions for all schemas in the profile.

#### Scenario: guards.ts provides custom functions
- **WHEN** `profiles/android/guards.ts` exports `{ isInvariantsPass, mutationOutputReady }`
- **THEN** these functions are callable as `isInvariantsPass(session)` in any guard expression

#### Scenario: Profile without guards.ts
- **WHEN** no `guards.ts` exists in the profile directory
- **THEN** only `session` is available in guard expressions

### Requirement: Schema SHALL be validated via Zod

The YAML schema file SHALL be parsed and validated against a Zod schema at load time. Invalid schemas SHALL be reported with a descriptive error and SHALL NOT be loaded.

#### Scenario: Valid schema passes validation
- **WHEN** a YAML schema file with valid structure is loaded
- **THEN** it passes Zod schema validation and is accepted

#### Scenario: Invalid schema fails validation
- **WHEN** a YAML schema file contains invalid field types or unknown top-level fields
- **THEN** it fails Zod schema validation with a descriptive error message
