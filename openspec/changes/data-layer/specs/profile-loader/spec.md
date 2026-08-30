# profile-loader Specification

## Purpose

Loads profiles from the root-level `profiles/` directory, validates profile metadata against the profile-config Zod schema, resolves `extends` chains across profiles, and loads YAML schema files listed in `schemas`. Produces resolved profile metadata (with inherited agents, skills, invariants) and a collection of loaded YAML schemas.

## ADDED Requirements

### Requirement: Loader SHALL discover profiles from root-level directory

The profile loader SHALL scan `<project-root>/profiles/*/profile.json` for available profiles. Each directory name under `profiles/` SHALL be used as the fallback profile id when `id` is absent.

#### Scenario: Loader discovers android profile
- **WHEN** file `<project-root>/profiles/android/profile.json` exists
- **THEN** the loader discovers profile with id `"android"`

#### Scenario: Missing profile directory
- **WHEN** no `profiles/` directory exists
- **THEN** the loader returns an empty profile set

### Requirement: Loader SHALL validate profile metadata against Zod schema

Each discovered profile.json SHALL be validated against the profile-config Zod schema before use. Invalid profiles SHALL be reported with a descriptive error and SHALL NOT be loaded into the runtime.

#### Scenario: Invalid profile metadata is rejected
- **WHEN** a profile.json fails Zod schema validation
- **THEN** the loader emits an error with the schema violation details and excludes the profile

### Requirement: Loader SHALL resolve profile extends chain

When a profile declares `extends`, the loader SHALL load the referenced profile from `profiles/<extended-id>/profile.json` and recursively resolve its extends chain. Circular extends SHALL be detected — chain stops on first repeat, partial resolution is used.

Agents, skills, and invariants SHALL be inherited from the extends chain. If the extending profile does not specify its own `agents`, `skills`, or `invariants`, the values from the nearest extended profile that defines them SHALL be used.

#### Scenario: Resolve valid profile extends
- **WHEN** profile `"android"` extends `"base"` and `profiles/base/profile.json` exists
- **THEN** the loader successfully resolves the extends chain

#### Scenario: Profile extends to non-existent profile
- **WHEN** profile extends `"unknown"` and no corresponding profile directory exists
- **THEN** the loader throws a fatal error during startup

### Requirement: Loader SHALL load YAML schemas from schemas list

For each entry in the profile's `schemas` array, the loader SHALL read and parse the corresponding YAML file from the profile directory. Each YAML schema SHALL be validated against the profile-schema Zod schema.

#### Scenario: Loader loads single schema
- **WHEN** profile.json contains `"schemas": ["state-machine.yaml"]`
- **THEN** the loader parses `profiles/<id>/state-machine.yaml` and validates it

#### Scenario: Loader loads multiple schemas
- **WHEN** profile.json contains `"schemas": ["workflow.yaml", "review.yaml"]`
- **THEN** both YAML files are loaded and validated

#### Scenario: Schema file does not exist
- **WHEN** a schema listed in `schemas` does not exist on disk
- **THEN** the loader emits a warning and skips that schema

#### Scenario: Schema fails validation
- **WHEN** a YAML schema fails Zod schema validation
- **THEN** the loader emits an error with the violation details and excludes that schema

### Requirement: Loader SHALL resolve schema extends chain

When a YAML schema declares `extends`, the loader SHALL load the referenced schema from `<profile-id>/<schema-filename>`. The referenced profile SHALL be resolved through the profile extends chain (an extended profile's schemas are available to the extending profile).

#### Scenario: Schema extends schema from extended profile
- **WHEN** profile `"android"` extends `"base"` and its schema contains `extends: "base/state-machine.yaml"`
- **THEN** the loader resolves `profiles/base/state-machine.yaml` as the base schema

### Requirement: Loader SHALL load guards.ts when present

After loading the profile metadata, the loader SHALL check for `guards.ts` in the profile directory. When present, the loader SHALL record its path for later use by the guard evaluator. The loader SHALL NOT compile or validate guard expressions at load time — that is the guard evaluator's responsibility.

#### Scenario: Loader discovers guards.ts
- **WHEN** file `profiles/<id>/guards.ts` exists
- **THEN** the loader records its path in the profile metadata for the guard evaluator

#### Scenario: Profile without guards.ts
- **WHEN** no `guards.ts` exists in the profile directory
- **THEN** only `session` is available in guard expressions

### Requirement: Loader SHALL resolve agentsDir and skillsDir defaults

The loader SHALL resolve `agentsDir` and `skillsDir` at load time. When a profile does not specify them, the defaults SHALL be `"agents"` and `"skills"` respectively, resolved relative to the profile directory.

#### Scenario: Resolve custom agentsDir
- **WHEN** profile.json specifies `"agentsDir": "custom-agents"`
- **THEN** the loader resolves agent prompts from `profiles/<id>/custom-agents/`

#### Scenario: Resolve default agentsDir
- **WHEN** profile.json has no `agentsDir` field
- **THEN** the loader uses `profiles/<id>/agents/` as the default

#### Scenario: skillsDir default
- **WHEN** profile.json specifies `"skillsDir": "custom-skills"`
- **THEN** the loader resolves skill files from `profiles/<id>/custom-skills/`
- **WHEN** profile.json has no `skillsDir` field
- **THEN** the loader uses `profiles/<id>/skills/` as the default

### Requirement: Loader SHALL support listing all profiles

The loader SHALL expose a function returning all discovered profile metadata for use by runtime and tooling.

#### Scenario: List available profiles
- **WHEN** tooling calls listProfiles()
- **THEN** it receives an array of `{ id, description, extends, schemas, agentsDir, skillsDir, agents, skills, invariants }` for every valid profile
