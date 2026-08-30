# profile-config Specification

## Purpose

Defines the profile metadata schema (`profile.json`). Profile metadata describes the profile's identity, its extended profile chain, the schemas it provides, and its resources (agents, skills, invariants). The state machine structure itself is defined in separate YAML schema files referenced by the `schemas` field.

## ADDED Requirements

### Requirement: Profile metadata SHALL include id field

profile.json SHALL include an optional `id` field. When present, the `id` field SHALL be the canonical profile identifier. When absent, the loader SHALL use the profile directory name as the identifier. The `id` field takes priority over directory name in all API results and config resolution.

#### Scenario: Profile id is canonical
- **WHEN** profile.json contains `"id": "ios"` in directory `profiles/android/`
- **THEN** the profile id is `"ios"` — the `id` field takes priority over the directory name

#### Scenario: Profile id matches directory name
- **WHEN** profile.json contains `"id": "android"` in directory `profiles/android/`
- **THEN** the profile id is `"android"`

#### Scenario: Profile without id uses directory name
- **WHEN** profile.json has no `id` field in directory `profiles/android/`
- **THEN** the profile id is `"android"` — falls back to directory name

### Requirement: Profile metadata SHALL include optional description field

profile.json SHALL support an optional `description` field for human-readable profile metadata.

#### Scenario: Profile with description
- **WHEN** profile.json contains `"description": "Android development profile"`
- **THEN** the profile description is available via `listProfiles()`

#### Scenario: Profile without description
- **WHEN** profile.json has no `description` field
- **THEN** `description` SHALL be `undefined` in `ProfileMetadata`

### Requirement: Profile metadata SHALL include optional extends field

profile.json SHALL support an optional `extends` field referencing another profile id. When present, the resolver SHALL resolve the extended profile and collect its metadata (agents, skills, invariants) and schemas as the base for inheritance. Resources (`agents`, `skills`, `invariants`) are inherited from the entire extends chain. Schemas from the extended profile are available for extension by this profile's schemas.

Circular extends SHALL be detected and handled by the **first-encounter wins** rule — the chain stops at a repeat and uses what was resolved so far.

#### Scenario: Profile extends another profile
- **WHEN** profile.json for `"android"` contains `"extends": "base"`
- **THEN** the resolver loads `profiles/base/profile.json` and collects its `agents`, `skills`, `invariants`, and `schemas` as the base for inheritance

#### Scenario: Extended profile provides agents
- **WHEN** `"base"` profile has `"agents": ["code", "architect"]` and `"android"` extends it
- **THEN** the android profile inherits `"agents": ["code", "architect"]` from base (profile may override)

#### Scenario: Profile without extends is standalone
- **WHEN** profile.json has no `extends` field
- **THEN** the profile has no inherited metadata or schemas

### Requirement: Profile metadata SHALL include schemas field

profile.json SHALL support an optional `schemas` field listing YAML schema filenames available in the profile directory. Each entry is a filename (without path) resolved relative to the profile directory. The schemas define the state machine structure (phases, transitions, gate mapping, settings, etc.).

#### Scenario: Profile with one schema
- **WHEN** profile.json contains `"schemas": ["state-machine.yaml"]`
- **THEN** the loader resolves `profiles/<id>/state-machine.yaml` as the profile's schema

#### Scenario: Profile with multiple schemas
- **WHEN** profile.json contains `"schemas": ["workflow.yaml", "review.yaml"]`
- **THEN** both YAML files are discovered as available schemas

#### Scenario: Profile without schemas
- **WHEN** profile.json has no `schemas` field
- **THEN** the profile provides no state machine structure; MAY be used only for agents/skills/invariants inheritance

### Requirement: Profile metadata SHALL include optional agentsDir field

profile.json SHALL support an optional `agentsDir` field specifying the directory for agent prompt files relative to the profile directory. Default value SHALL be `"agents"`.

#### Scenario: Profile specifies agentsDir
- **WHEN** profile.json contains `"agentsDir": "custom-agents"`
- **THEN** the agent prompts are resolved from `profiles/<id>/custom-agents/`

#### Scenario: Profile uses default agentsDir
- **WHEN** profile.json has no `agentsDir` field
- **THEN** the agent prompts are resolved from `profiles/<id>/agents/`

### Requirement: Profile metadata SHALL include optional skillsDir field

profile.json SHALL support an optional `skillsDir` field specifying the directory for skill files relative to the profile directory. Default value SHALL be `"skills"`.

#### Scenario: Profile specifies skillsDir
- **WHEN** profile.json contains `"skillsDir": "custom-skills"`
- **THEN** the skill files are resolved from `profiles/<id>/custom-skills/`

#### Scenario: Profile uses default skillsDir
- **WHEN** profile.json has no `skillsDir` field
- **THEN** the skill files are resolved from `profiles/<id>/skills/`

### Requirement: Profile metadata SHALL support agents list

profile.json SHALL support an optional `agents` array listing available agent identifiers for this profile. When the profile has `extends`, the agents list from the extended profile SHALL be used as the base, and this profile's agents SHALL fully override it.

#### Scenario: Profile specifies agents
- **WHEN** profile.json contains `"agents": ["code", "architect", "qa"]`
- **THEN** the profile's resolved agents are `["code", "architect", "qa"]`

#### Scenario: Profile inherits agents from extends
- **WHEN** profile extends another profile and does not specify `agents`
- **THEN** the agents from the extended profile are inherited

### Requirement: Profile metadata SHALL support skills list

profile.json SHALL support an optional `skills` array listing available skill identifiers for this profile. Same inheritance semantics as `agents`.

#### Scenario: Profile specifies skills
- **WHEN** profile.json contains `"skills": ["code-review", "testing"]`
- **THEN** the profile's resolved skills are `["code-review", "testing"]`

#### Scenario: Profile inherits skills from extends
- **WHEN** profile extends another profile and does not specify `skills`
- **THEN** the skills from the extended profile are inherited

### Requirement: Profile metadata SHALL support invariants list

profile.json SHALL support an optional `invariants` array listing invariant identifiers for this profile. Same inheritance semantics as `agents`.

#### Scenario: Profile specifies invariants
- **WHEN** profile.json contains `"invariants": ["no-console", "strict-null"]`
- **THEN** the profile's resolved invariants are `["no-console", "strict-null"]`

#### Scenario: Profile inherits invariants from extends
- **WHEN** profile extends another profile and does not specify `invariants`
- **THEN** the invariants from the extended profile are inherited

### Requirement: Profile metadata SHALL be validated via Zod

The profile.json schema SHALL be defined as a Zod schema with type inference. A JSON Schema SHALL be generated from it via `zod-to-json-schema` for IDE support and CI validation.

#### Scenario: Valid metadata passes schema validation
- **WHEN** a profile.json file with valid fields is loaded
- **THEN** it passes Zod schema validation and is accepted

#### Scenario: Invalid metadata fails schema validation
- **WHEN** a profile.json file contains an unknown top-level field or invalid value types
- **THEN** it fails Zod schema validation with a descriptive error message
