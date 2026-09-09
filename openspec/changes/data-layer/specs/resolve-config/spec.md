# resolve-config Specification

## Purpose

Defines how resolveConfig resolves the full configuration from a profileId. Resolution operates at two levels:

1. **Profile metadata resolution** — resolves the profile's `extends` chain, collecting `agents`, `skills`, and `invariants` from the entire chain.
2. **Schema resolution** — for each YAML schema in the profile's `schemas` list, resolves its `extends` chain and applies field-type-aware merge to produce the resolved schema.

## ADDED Requirements

### Requirement: resolveConfig SHALL accept profileId as primary input

The resolveConfig function SHALL accept a `profileId` string. It SHALL load the profile metadata, resolve its extends chain, and load and resolve all listed YAML schemas. It SHALL NOT use `session.preset` as the primary config selector.

#### Scenario: resolveConfig with valid profileId
- **WHEN** resolveConfig is called with `profileId: "android"`
- **THEN** it loads the android profile, resolves its extends chain, loads all schemas from `schemas`, resolves each schema's extends chain, and returns resolved metadata + resolved schemas

#### Scenario: resolveConfig with unknown profileId
- **WHEN** resolveConfig is called with a profileId that does not match any profile
- **THEN** it throws a fatal error

### Requirement: Profile metadata merge SHALL follows extends chain

The metadata merge across a profile's extends chain SHALL follow these rules:
- `agents`, `skills`, `invariants`: inherit from nearest extended profile that defines them; the extending profile's values fully override when present
- `agentsDir`, `skillsDir`: override from the extending profile; not inherited from extends chain
- `schemas`: inherited from the extended profile AND combined with the extending profile's own schemas

#### Scenario: Profile inherits agents from extends
- **WHEN** profile `"android"` extends `"base"` and does not specify `agents`
- **THEN** `android` inherits `agents` from `"base"`

#### Scenario: Profile overrides agents from extends
- **WHEN** profile `"android"` extends `"base"` and specifies its own `agents`
- **THEN** the extending profile's `agents` fully override the inherited value

### Requirement: Schema merge SHALL be field-type-aware

The merge between a base schema (from schema extends) and an extending schema SHALL follow these rules:
- `phaseAssignments`: replace by matching `id`, append new ones
- `gateMapping`: full override when present in extending schema
- `settings`: deep merge (extending values override base by key)
- `phases`: full override when present in extending schema
- `editingAgents`, `verifiers`, `requiredGates`, `actionGuards`: full override when present
- `transitions`: full override when present

#### Scenario: Schema mixed merge with extends
- **WHEN** schema extends `"base/session-guard.yaml"` and specifies only `gateMapping` and `phaseAssignments` with one replacement and one addition
- **THEN** the resulting resolved schema has base settings inherited, base phases inherited, base transitions inherited, gateMapping fully from extending schema, phaseAssignments as base + replacement + addition

### Requirement: resolveConfig SHALL return ResolvedProfile with metadata and schemas

The resolveConfig function SHALL return a structured result containing:
- Resolved profile metadata (id, description, agents, skills, invariants, agentsDir, skillsDir)
- A list of resolved YAML schemas (each with its fields fully merged through extends chain)

#### Scenario: resolveConfig returns structured result
- **WHEN** resolveConfig completes successfully
- **THEN** it returns `{ metadata: ResolvedMetadata, schemas: ResolvedSchema[] }` — the metadata is the *resolved* form (extends chain applied, `agentsDir`/`skillsDir` absolute), not the raw `ProfileMetadata` read off disk

### Requirement: WorkflowSession SHALL have profileId field

`WorkflowSession` SHALL include a `profileId: string` field. The `preset` field SHALL be marked `@deprecated` and SHALL remain for backward compatibility as a read-only artifact computed from the resolved profile's extends chain.

#### Scenario: workflow.create stores profileId
- **WHEN** `workflow.create({ profileId: "android" })` is called
- **THEN** `session.profileId` equals `"android"`

#### Scenario: profileId persists across session reloads
- **WHEN** a session is saved and reloaded from disk
- **THEN** `session.profileId` retains its original value

### Requirement: workflow.create SHALL accept profileId

The `workflow.create` tool SHALL accept `profileId: string` as its argument. `preset` SHALL be removed or treated as a legacy fallback with deprecation warning.

#### Scenario: workflow.create with profileId
- **WHEN** agent calls `workflow.create({ profileId: "android" })`
- **THEN** a WorkflowSession is created with `profileId: "android"` and the resolved config is built from the android profile

#### Scenario: workflow.create without profileId falls back
- **WHEN** agent calls `workflow.create({})` and `HARNESS_PROFILE` env is set
- **THEN** the env variable is used as profileId
