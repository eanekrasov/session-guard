# Tasks: Profile config library for OpenCode plugins

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 600-800 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: Foundation (types, schemas, tests) → PR 2: Loaders & merge → PR 3: resolveConfig |
| Delivery strategy | single-pr |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Zod schemas, types, JSON Schema generation | PR 1 | `bun test src/schema/` | `bun test --coverage` | `src/schema/`, `*.schema.json` |
| 2 | ProfileLoader, SchemaLoader, GuardEvaluator, merge logic | PR 2 | `bun test src/profile-loader.test.ts src/schema-loader.test.ts src/guard-evaluator.test.ts` | `bun test --coverage` | `src/profile-loader.ts`, `src/schema-loader.ts`, `src/guard-evaluator.ts` |
| 3 | resolveConfig, public API, integration tests | PR 3 | `bun test` | `bun test --coverage` | `src/public-api.ts`, `src/index.ts`, `src/resolve-config.ts` |

## Phase 1: Foundation — types, Zod schemas, JSON Schema generation

- [ ] 1.1 Add deps to `package.json`: `zod`, `zod-to-json-schema`, `yaml` (runtime), `@types/yaml` (dev)
- [ ] 1.2 RED: write failing tests for `ProfileMetadataSchema` (valid profile, invalid profile, missing id → dir name, unknown fields rejected)
- [ ] 1.3 Create `src/schema/profile-metadata.ts` — `ProfileMetadataSchema` Zod schema (id, description, extends, schemas, agentsDir, skillsDir, agents, skills, invariants)
- [ ] 1.4 RED: write failing tests for `ProfileSchemaSchema` (valid schema, invalid schema, extends, phases, transitions, gateMapping, settings, phaseAssignments, editingAgents, verifiers, requiredGates, actionGuards)
- [ ] 1.5 Create `src/schema/profile-schema.ts` — `ProfileSchemaSchema` Zod schema (extends, phases, transitions, gateMapping, settings, phaseAssignments, editingAgents, verifiers, requiredGates, actionGuards)
- [ ] 1.6 Create `src/schema/types.ts` — all TypeScript types/interfaces (ProfileMetadata, ResolvedMetadata, ProfileSchema, ResolvedSchema, PhaseDef, StageDef, Transition, PhaseAssignmentRule, ResolvedProfile)
- [ ] 1.7 Generate JSON Schemas: `profile.schema.json` + `profile-schema.schema.json` via `zod-to-json-schema`

## Phase 2: Core — loaders, merge logic, guard evaluator

- [ ] 2.1 RED: write failing tests for `ProfileLoader` (discovery, validation, extends chain resolution, circular extends `first-encounter-wins`, missing extends → fatal, guards.ts discovery)
- [ ] 2.2 Create `src/profile-loader.ts` — scan `profiles/*/profile.json`, validate via `ProfileMetadataSchema`, resolve extends chain (recursive, circular detection), load guards.ts path
- [ ] 2.3 RED: write failing tests for `SchemaLoader` (YAML loading, validation, schema extends resolution, cross-profile extends, circular extends, missing schema file → warning, invalid schema → error)
- [ ] 2.4 Create `src/schema-loader.ts` — load YAML, validate via `ProfileSchemaSchema`, resolve schema extends chain, apply field-type-aware merge (D3 rules: `phaseAssignments` replace-by-id, `settings` deep-merge, rest full-override)
- [ ] 2.5 RED: write failing tests for `GuardEvaluator` (session access, custom guards from guards.ts exports, logical operators, arrow functions, sandbox isolation — no `require`/`import`/`fetch`)
- [ ] 2.6 Create `src/guard-evaluator.ts` — `new Function()` based JS expression evaluator with sandboxed context (session + guards exports)

## Phase 3: Integration — resolveConfig, public API, wiring

- [ ] 3.1 Create `src/resolve-config.ts` — top-level `resolveConfig(profileId, profilesDir)` that orchestrates loader → schema resolution → merge → return `ResolvedProfile`
- [ ] 3.2 Create `src/public-api.ts` — exported entry points: `resolveConfig()`, `listProfiles()`
- [ ] 3.3 Modify `src/index.ts` — re-export public API
- [ ] 3.4 RED: write integration tests for `resolveConfig` end-to-end (two-level extends, valid + unknown profileId, missing profile → fatal)
- [ ] 3.5 RED: write integration tests for `listProfiles` (valid profiles, empty dir)
- [ ] 3.6 Verify `mise run build`, `mise run lint`, `bun test --coverage` all pass
