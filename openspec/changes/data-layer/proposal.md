# Proposal: Profile config library for OpenCode plugins

## Intent

A reusable npm library that provides a profile-based configuration system for OpenCode plugin packages. Plugin authors describe their configuration through `profile.json` files with optional `extends` for composition. The library handles schema validation, profile loading, extends resolution, and config merging — and exposes the resolved config to the plugin's OpenCode runtime.

No built-in presets or defaults. Presets are separate npm packages that plugin consumers can optionally depend on. Profiles can run standalone (no `extends`) or inherit from any preset package.

## Scope

### In Scope
- `profile.json` schema definition with all config fields (phaseAssignments, gateMap, settings, phases, agents, skills, etc.)
- Profile loader: scans a project `profiles/` directory, validates every profile against the Zod schema
- `extends` resolution: chain loading with runtime validation (missing extends → warning, treated as standalone)
- Config merge logic: typed merge rules per field (replace-by-id for phaseAssignments, deep merge for settings, full override for arrays)
- `resolveConfig(profileId)` → returns resolved config object
- JSON Schema generated from Zod for IDE autocompletion
- Condition DSL parser as extractable utility (reused across any profile's phaseAssignments)
- `listProfiles()` — introspection API for OpenCode plugin runtime
- No built-in presets — the library ships only with logic

### Out of Scope
- Built-in preset packages (high/medium/low or others) — separate packages
- CLI tooling (`profile init`, `profile list` CLI verbs) — planned for future
- Template/variable substitution in profiles
- Runtime storage or session management — handled by the OpenCode plugin host
- `workflow.create` or any workflow orchestration — out of scope for this library

## Capabilities

### New Capabilities
- `profile-config`: JSON Schema definition for profile.json, Zod runtime validation, JSON Schema generation
- `profile-loader`: File-system profile discovery, validation, extends chain resolution
- `resolve-config`: Profile-first config resolution with typed merge
- `condition-dsl`: Extracted condition predicate compiler (exists, equals, contains, agentIs, etc.)

### Modified Capabilities

None — new library, no existing spec files to modify.

## Approach

1. Define `ProfileConfig` TypeScript type + Zod schema (`src/schema/profile.ts`): extends, phaseAssignments, gateMap, settings, phases, editingAgents, verifiers, requiredGates, actionGuards, agents, skills, invariants
2. Generate JSON Schema from Zod via `zod-to-json-schema`; publish as `profile.schema.json`
3. Implement `ProfileLoader` class: `load(profilesDir: string)` → `Map<string, ProfileConfig>`, validates each, resolves extends chain
4. Implement `resolveConfig(profileId, profilesDir)` → typed `ResolvedConfig`: load profile → if extends → load base → merge per field rules
5. Implement typed merge per field rules (design.md D2)
6. Extract condition DSL parser into `src/condition-dsl.ts`
7. Expose public API: `listProfiles()`, `resolveConfig()`, `ProfileLoader`, `ResolvedConfig` type
8. Plugin integration hook: one public function that an OpenCode plugin calls during its own init to load its profile config

## Affected Areas

| Area                    | Impact | Description                                    |
|-------------------------|--------|------------------------------------------------|
| `src/schema/profile.ts` | New    | ProfileConfig type + Zod schema                |
| `src/profile-loader.ts` | New    | Directory scanner, validator, extends resolver |
| `src/resolve-config.ts` | New    | Profile-first merge into ResolvedConfig        |
| `src/condition-dsl.ts`  | New    | Condition predicate compiler                   |
| `src/public-api.ts`     | New    | Exported entry points for plugin consumers     |
| `profile.schema.json`   | New    | Generated JSON Schema artifact                 |
| `test/`                 | New    | Unit + integration test suite                  |

## Risks

| Risk                                           | Likelihood | Mitigation                                                                                         |
|------------------------------------------------|------------|----------------------------------------------------------------------------------------------------|
| OpenCode plugin API changes in future versions | Low        | Isolate integration behind an adapter interface; version-pin `@opencode-ai/plugin` peer dependency |
| Teams expect built-in presets, find none       | Medium     | README documents how to create profiles and links to community preset packages                     |
| Extends resolution on missing file is subtle   | Low        | Warning logged with file path; profile treated as standalone — visible in logs, not silent         |

## Rollback Plan

Remove the package dependency from the plugin. Restore any existing hardcoded config. The library is additive — no existing data is mutated.

## Dependencies

- `@opencode-ai/plugin` (peer dependency)
- `zod`, `zod-to-json-schema` (runtime deps)
- `typescript`, `bun` (dev)

## Success Criteria

- [ ] `resolveConfig("my-profile", "./profiles")` returns correct merged config for both extends and standalone profiles
- [ ] Missing extends file logs a warning and treats the profile as standalone
- [ ] JSON Schema generated from Zod covers all profile fields and validates all examples
- [ ] `listProfiles()` returns all valid profiles from the directory
- [ ] Condition DSL parses all operators (`exists`, `notExists`, `equals`, `agentIs`, `contains`) and `&&` conjunctions
- [ ] All unit tests pass: valid profiles, invalid profiles, extends chains, missing extends, empty directory
- [ ] OpenCode plugin can call the public API to load its own profile config during initialization
