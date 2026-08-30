# Exploration: config-layer

## Current State

This project (`state-machine`) was initialized from a `bun-module` template with two commits:

1. `dabd1c3` — **chore: initialize state-machine from bun-module template** — Created the template skeleton (package.json with `{{moduleName}}` placeholders, tsconfig, AGENTS.md, eslint, mise tasks, GitHub Actions workflows). No real code.
2. `97e9238` — **wip** — Added the config-layer OpenSpec artifacts (proposal.md, design.md, 3 spec files) and a `.gitignore` update.

The actual source code (`src/`) is effectively empty:
- `src/index.ts` — `export {};` (no-op placeholder)
- `src/schema/` — empty directory
- `src/` — only `index.ts` and `schema/` exist, no other files

Other observations:
- `test/` directory exists with two empty fixture directories (`profiles/`, `empty-profiles/`) — likely intended for the config-layer tests
- No `profiles/` directory at root level
- No `presets/` directory at root level
- No `config/` directory anywhere in the project
- No `dist/` directory (build never run)
- No `scripts/` content
- `package.json` still has template placeholders (`{{moduleName}}`, `{{description}}`, `{{authorName}}`, etc.)
- No runtime dependencies installed (`zod`, `zod-to-json-schema` are absent from `package.json`)
- Only devDependencies (eslint, vitest, typescript, prettier) are listed
- `openspec/specs/` is empty (no main specs exist yet)
- `openspec/config.yaml` has proper config but specifies `strict_tdd: true`

## Affected Areas

| Area | Status | Notes |
|------|--------|-------|
| `src/index.ts` | Exists (empty) | Needs complete rewrite for public API exports |
| `src/schema/profile.ts` | Does not exist | Proposal item — must be created |
| `src/profile-loader.ts` | Does not exist | Proposal item — must be created |
| `src/resolve-config.ts` | Does not exist | Proposal item — must be created |
| `src/condition-dsl.ts` | Does not exist | Proposal item — must be created |
| `src/public-api.ts` | Does not exist | Proposal item — must be created |
| `profile.schema.json` | Does not exist | Generated artifact (from Zod schema) |
| `profiles/` directory | Does not exist | Design describes root-level profiles/ |
| `presets/base/` directory | Does not exist | Design describes preset YAML move to presets/base/ |
| `package.json` | Exists (template) | Needs real metadata + runtime deps (zod, zod-to-json-schema) |
| `test/` | Exists (empty fixtures) | Needs full test suite |
| `openspec/specs/` | Exists (empty) | Main specs to be created after archive |

## Gap Analysis

### Already Done (Preexisting)
- **Nothing in the codebase** — the entire config-layer is planned but unimplemented.
- The OpenSpec planning artifacts (proposal, design, 3 specs) are the only concrete output so far.

### What Would Be New Work (Everything)

| Capability | Status | Details |
|------------|--------|---------|
| ProfileConfig Zod schema | New | `src/schema/profile.ts` — from scratch |
| JSON Schema generation | New | `zod-to-json-schema` dependency needed |
| ProfileLoader | New | `src/profile-loader.ts` — directory scanner, validator, extends resolver |
| resolveConfig | New | `src/resolve-config.ts` — profile-first merge logic |
| Condition DSL parser | New | `src/condition-dsl.ts` — extracted from what would be presets |
| Public API | New | `src/public-api.ts` — entry points for consumers |
| Package setup | New | Fix template placeholders, add zod deps |
| Profiles directory | New | Root-level `profiles/android/profile.json`, etc. |
| Presets directory | New | Root-level `presets/base/{high,medium,low}.yaml` |
| Test suite | New | Unit + integration tests |
| Main specs | New | `openspec/specs/` empty — needs population after archive |

## Feasibility

### Technical Blockers
- **None identified.** This is a greenfield implementation in an empty template project. No existing code conflicts.
- Missing runtime deps (`zod`, `zod-to-json-schema`) are standard npm packages, well-documented, Bun-compatible.

### Design vs Proposal Mismatches
1. **Proposal** says `extends` to a missing file → **warning, treated as standalone**. **Specs** (profile-loader spec) say → **fatal error at startup**. This is a contradiction that must be resolved.
2. **Design (D4)** describes moving presets from `state-machine/config/` to `presets/base/`. But there is no `state-machine/config/` path in this project — the design references a parent/neighbor module that doesn't exist in this repo. The proposal describes this as a **reusable npm library** with no built-in presets, which contradicts the design's "move presets" story.
3. **Design** is written in Russian and describes the current architecture as having "two-axis config" (preset × profile) with `state-machine/config/presets/default.yaml` — but no such files exist in this project. The design seems to describe a **different module** (perhaps a parent OpenCode plugin) rather than this specific library.

### Architectural Conflicts
- **Fundamental scope confusion**: The proposal says this is a **reusable npm library** for any OpenCode plugin. The design describes migrating config from an **existing `state-machine/` plugin** where presets are already defined. These are two different layers — the library vs. its first consumer.
- The `extends` in the proposal references **preset IDs** (`"low"`, `"medium"`, `"high"`). But the library isn't supposed to ship with built-in presets. The design says presets live in `presets/base/`. But who creates them? If the library doesn't ship presets, each consumer project needs its own. This tension needs resolution.

## Completeness of Specs

### Covered by Specs
- **profile-config spec**: extends field, phaseAssignments, gateMap override, settings merge, phases override, Zod validation — all covered.
- **profile-loader spec**: directory discovery, schema validation, extends resolution, listProfiles — all covered.
- **resolve-config spec**: profileId as primary input, WorkflowSession.profileId, field-type-aware merge rules, workflow.create acceptance — all covered.

### Not Covered / Missing
1. **condition-dsl spec is missing entirely.** The proposal lists it as a capability, the design D3 calls for extracting it, but there is no `specs/condition-dsl/spec.md`.
2. **No spec for extends error behavior.** Proposal says "warning + standalone", specs say "fatal error" — contradictory, no unified spec.
3. **No spec for the environment-based profile resolution** (`HARNESS_PROFILE` env var mentioned in resolve-config spec scenario but not detailed).
4. **No spec for backward compatibility** — `session.preset` deprecation path not specified.
5. **No schema for the standalone profile case** — what are the required vs. optional fields when no `extends`?
6. **No spec for JSON Schema generation** — format, publishing, versioning.
7. **No spec for `listProfiles()` return schema** — profile-loader spec lists it but doesn't define the return type in detail.
8. **`profiles/` directory structure vs `test/fixtures/profiles/`** — specs reference root-level `profiles/`, no spec for test fixtures.
9. **Plugins directory vs YAML vs JSON** — design references preset YAML files. But `profiles` would be JSON (profile.json). Mixing formats needs explicit spec.
10. **Circular extends detection** — not mentioned anywhere.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Scope confusion: library vs consumer | High | High | Clarify: is this a generic library or a specific plugin refactor? Proposal says library, design says refactor. Must pick one. |
| extends error behavior contradiction | High | Medium | Resolve: warning+standalone vs fatal error. Specs must agree with each other. |
| Template project is uninitialized | None | Low | Non-blocking — `package.json` placeholders must be fixed before publish but not before coding. |
| No tests or code to validate against | Low | Medium | Greenfield means all assumptions are untested until implementation. |
| condition-dsl extraction without source | Low | Low | The design says "extract from state-machine/config/presets/default.ts" — but that source doesn't exist in this project. The DSL must be written from scratch or defined independently. |
| Missing zod dependency | None | Low | Easy fix — `bun add zod zod-to-json-schema`. |
| Delivery strategy not yet chosen | Low | Medium | No PR budget forecast done. ~600+ lines of new code likely. Consider chained PRs. |

## Recommendations

### Next Step: sdd-tasks (with caveats)

The logical next phase is **sdd-tasks**, but **only after the following issues are resolved first**:

1. **Resolve the scope ambiguity**: The proposal describes a **generic reusable npm library**. The design describes a **specific migration of an existing module's config**. These are incompatible starting points. **Recommendation**: Adopt the proposal's vision (generic library) and update the design to match. Remove references to `state-machine/config/` paths that don't exist and describe the library in standalone terms.

2. **Fix the extends error contradiction**: Align the proposal ("warning + standalone") with the specs ("fatal error"). **Recommendation**: Use the spec's approach (fatal error at startup) — silent failures in config loading create hard-to-debug runtime issues. But allow the profile to have a `partial` mode.

3. **Add missing condition-dsl spec**: A 4th spec file is needed before tasks can be accurate.

4. **Update design.md** to reflect library-only scope, remove references to existing `state-machine/config/` paths, and clarify the preset storage model (is it the library's problem or the consumer's?).

5. **Commit the `package.json` template fixes** as a trivial cleanup task.

### Recommendation: Update Design First

The design.md is written in Russian and references a codebase that doesn't exist in this project. Before proceeding to tasks, **update the design** to:
- Match the proposal's "reusable npm library" scope
- Remove references to `state-machine/config/presets/` (doesn't exist here)
- Clarify the preset/profiles directory structure in terms of this project
- Add a decision about extends error behavior (fatal vs warning)
- Add condition-dsl to the design decisions

After design update, either **sdd-spec** (to add the missing condition-dsl spec) or **sdd-tasks** (with all specs complete).

## Ready for Tasks?

**No** — not until the design ambiguity and the extends contradiction are resolved. The exploratory work uncovered a fundamental scope mismatch between the proposal (generic library) and the design (specific plugin refactor). Proceeding to tasks with both interpretations active would create wasted work.
