# Design: Profile config library for OpenCode plugins

## Technical Approach

Standalone npm package (`@opencode-ai/profile-config`) consumed by OpenCode plugins. Zero built-in presets or schemas. The library provides Zod-driven validation for both profile metadata (`profile.json`) and YAML schema files, file-system profile discovery, two-level extends resolution (profile metadata chain + schema chain), typed field-aware merge for YAML schemas, and a JS-expression guard evaluator for guards, exit conditions, and phase assignment conditions. Consumer plugins install the library, ship `profiles/<id>/` directories with `profile.json` and YAML schema files, and call `resolveConfig()` at init.

The library operates at two levels:
1. **Profile metadata** — identity, human-readable fields, extends chain for resource inheritance (agents, skills, invariants), and a list of available YAML schemas.
2. **Profile schemas** — YAML files describing state machine structure (phases, transitions, gate mapping, settings, phase assignments). Each schema independently supports `extends` to inherit and merge from a schema in the extended profile chain.

The library is additive — no migration, no backward compatibility shims.

## Architecture Decisions

### D1: Profile-first resolution model

`resolveConfig(profileId)` loads the profile metadata, resolves its extends chain, loads all YAML schemas from `schemas`, resolves each schema's extends chain, and returns resolved metadata + resolved schemas. No two-axis model — profile is singular.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Profile-first | Single source of truth; `extends` makes independent profiles possible | **Chosen** |
| Two-axis (preset × profile) | Adds complexity; `session.preset` is a legacy concept | Rejected — library has no legacy |

### D2: Metadata merge rules (profile extends chain)

| Field | Merge Rule | Rationale |
|-------|-----------|-----------|
| `extends` | Resolved before merge | Used only for resolution |
| `agents` | Inherit from nearest extended profile; full override when present | Agent list is a unit |
| `skills` | Inherit from nearest extended profile; full override when present | Same structural reasoning |
| `invariants` | Inherit from nearest extended profile; full override when present | Invariant list is a unit |
| `agentsDir` | Not inherited — always from the extending profile | Resource directory is local |
| `skillsDir` | Not inherited — always from the extending profile | Resource directory is local |
| `schemas` | Combined: extended profile's schemas + extending profile's schemas | All schemas in the chain are available |

### D3: Schema merge rules (YAML extends chain)

| Field | Merge Rule | Rationale |
|-------|-----------|-----------|
| `extends` | Resolved before merge | Used only for resolution |
| `phaseAssignments` | Replace by matching `id`, append new | Arrays of identified objects |
| `gateMapping` | Full override when present | Gate stages are an all-or-nothing decision |
| `settings` | Deep merge (recursive) | Nested key-value pairs |
| `phases` | Full override when present | Phase set is a structural choice |
| `transitions` | Full override when present | Transition graph is a structural choice |
| `editingAgents` | Full override when present | Agent list is a unit |
| `verifiers` | Full override when present | Same structural reasoning |
| `requiredGates` | Full override when present | Gate list is a unit |
| `actionGuards` | Full override when present | Same structural reasoning |

Alternative: universal deep merge — rejected because array concatenation produces surprising results (e.g., duplicate agents).

### D4: JS-expression guard evaluator

All guard and condition fields in schemas use **JavaScript-like expression syntax**. Expressions are compiled at runtime via `new Function()` with access to:
- `session` — the current `WorkflowSession` context
- Exports from the profile's `guards.ts` file (when present) — custom helper functions

Profile authors can provide custom guard functions in `profiles/<id>/guards.ts`. Each exported function becomes available in guard expressions.

**Example `guards.ts`:**
```typescript
export function isInvariantsPass(session: Session): boolean {
  return session.gates.find(g => g.id === 'invariants')?.status === 'pass';
}
export function mutationOutputReady(session: Session): boolean {
  return session.activeMutation?.outputReady === true;
}
```

**Example schema YAML:**
```yaml
stages:
  dev:
    exitGuards:
      - "isInvariantsPass(session)"
transitions:
  - from: PLANNING
    to: EXECUTION
    guard: "session.planApproved == true && session.tasks.length > 0"
```

**Supported expression features:**
- Property access: `session.property`, `session.nested.property`
- Method calls: `session.gates.find(g => g.id === 'x')`
- Comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logical operators: `&&`, `||`, `!`
- Ternary: `condition ? a : b`
- Custom functions from `guards.ts`: `myGuard(session, arg1)`

**Choice**: Compile expressions via `new Function()` with a sandboxed context (session + guards exports). All custom function calls are explicitly provided through the context — no access to global scope, `require`, `import`, `fetch`, or I/O.
**Alternative**: Use a proper expression parser (e.g., `jsep` + custom evaluator) — rejected because it adds a dependency and complexity for simple predicate evaluation. Scope-limited `new Function()` is sufficient for guard expressions.
**Note**: No separate condition DSL module. All guard/condition fields use the same JS-expression engine.

### D5: Standalone library — no built-in presets

The library ships zero preset files and zero schema files. All profiles and schemas are provided by the consumer project or preset npm packages. Profiles may optionally include `guards.ts` with exported helper functions available in guard expressions.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| No built-in presets | Consumers must provide their own profiles and schemas | **Chosen** — matches proposal scope |
| Ship presets/base/{high,medium,low} | Adds maintenance burden and coupling to a specific plugin | Rejected — library stays universal |

### D6: Two separate Zod schemas

The library defines two Zod schemas: one for profile metadata (`ProfileMetadataSchema`, validates `profile.json`) and one for YAML schema files (`ProfileSchemaSchema`, validates `*.yaml`). Both generate JSON Schema via `zod-to-json-schema`.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Two separate Zod schemas | Clear separation of concerns; metadata and structure evolve independently | **Chosen** |
| Single unified schema | Mixes metadata with state machine structure | Rejected — two different concerns |

### D7: JSON Schema from Zod via zod-to-json-schema

Zod schemas are the single source of truth. `zod-to-json-schema` generates JSON Schema artifacts at build time for IDE autocompletion and CI validation.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Zod → JSON Schema generation | Single source of truth, auto-synced | **Chosen** |
| Hand-written JSON Schema | Drifts from TS types, manual maintenance | Rejected |

## Data Flow

```
Consumer plugin init
       │
       ▼
resolveConfig("android", "./profiles")
       │
       ├─► ProfileLoader.load("./profiles")
       │       │
       │       ├─► Scan profiles/*/profile.json
       │       ├─► Validate each via ProfileMetadataSchema
       │       ├─► Resolve profile extends chain (metadata)
       │       │    ├─► Collect agents, skills, invariants
       │       │    └─► Detect circular extends → first-encounter wins
       │       │
       │       ├─► For each schema in schemas[]:
       │       │       ├─► Load <profileDir>/<schema>.yaml
       │       │       ├─► Validate via ProfileSchemaSchema
       │       │       ├─► Resolve schema extends chain
       │       │       └─► Merge base + extending schema (D3 table)
       │       │
       │       ├─► Load guards.ts from profile directory (optional)
       │       │       └─► Export map for guard-evaluator context
       │       │
       │       └─► Return { metadata: ProfileMetadata, schemas: ResolvedSchema[] }
       │
       └─► Return to consumer
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Real name, deps: zod, zod-to-json-schema, yaml |
| `src/index.ts` | Modify | Re-export public API |
| `src/schema/profile-metadata.ts` | Create | ProfileMetadata Zod schema (id, description, extends, schemas, agentsDir, skillsDir, agents, skills, invariants) |
| `src/schema/profile-schema.ts` | Create | ProfileSchema Zod schema (extends, phases, transitions, gateMapping, settings, phaseAssignments, editingAgents, verifiers, requiredGates, actionGuards) |
| `src/schema/types.ts` | Create | ProfileMetadata, ResolvedSchema, Condition types |
| `src/profile-loader.ts` | Create | File discovery, metadata validation, profile extends chain resolution |
| `src/schema-loader.ts` | Create | YAML loading, schema validation, schema extends chain resolution, schema merge |
| `src/guard-evaluator.ts` | Create | JS-expression guard evaluator with sandboxed context (session + guards exports) |
| `src/public-api.ts` | Create | Exported entry points (resolveConfig, listProfiles) |
| `profiles/<id>/guards.ts` | Consumer-owned | Optional — exported functions available in guard expressions |
| `profile.schema.json` | Create | Generated JSON Schema for profile metadata |
| `profile-schema.schema.json` | Create | Generated JSON Schema for YAML schema files |
| `tsconfig.json` | Modify | Ensure outdir includes generated schemas |

## Interfaces / Contracts

```typescript
// ─── Public API — consumer entry points ────────────────────────────────────
export function resolveConfig(profileId: string, profilesDir: string): ResolvedProfile;
export function listProfiles(profilesDir: string): ProfileMetadata[];

// ─── Profile Metadata (profile.json) ───────────────────────────────────────
interface ProfileMetadata {
  id: string;                      // canonical identifier (from id field or directory name)
  description?: string;            // human-readable metadata
  extends?: string;                // profile id to extend (optional)
  schemas?: string[];              // YAML schema filenames (optional)
  agentsDir?: string;              // relative to profile directory, default "agents"
  skillsDir?: string;              // relative to profile directory, default "skills"
  agents?: string[];               // agent identifiers (optional, inherited from extends)
  skills?: string[];               // skill identifiers (optional, inherited from extends)
  invariants?: string[];           // invariant identifiers (optional, inherited from extends)
}

// ─── Profile Schema (YAML) ─────────────────────────────────────────────────
interface ProfileSchema {
  extends?: string;                // "<profile-id>/<schema-filename>" (optional)
  phases?: Record<string, PhaseDef>;
  transitions?: Transition[];
  gateMapping?: Record<string, string[]>;
  settings?: Record<string, unknown>;
  phaseAssignments?: PhaseAssignmentRule[];
  editingAgents?: string[];
  verifiers?: string[];
  requiredGates?: string[];
  actionGuards?: string[];
}

// ─── Resolved output ───────────────────────────────────────────────────────
interface ResolvedProfile {
  metadata: ResolvedMetadata;       // profile metadata with extends resolved
  schemas: ResolvedSchema[];        // each schema with its extends resolved
}

interface ResolvedMetadata {
  id: string;
  description?: string;
  agents: string[];                 // fully resolved (inherited + overrides)
  skills: string[];                 // fully resolved
  invariants: string[];             // fully resolved
  agentsDir: string;                // resolved to absolute path
  skillsDir: string;                // resolved to absolute path
}

interface ResolvedSchema {
  source: string;                   // "<profile-id>/<schema-filename>"
  phases?: Record<string, PhaseDef>;
  transitions?: Transition[];
  gateMapping?: Record<string, string[]>;
  settings?: Record<string, unknown>;
  phaseAssignments?: PhaseAssignmentRule[];
  editingAgents?: string[];
  verifiers?: string[];
  requiredGates?: string[];
  actionGuards?: string[];
}

// ─── Supporting types ──────────────────────────────────────────────────────
interface PhaseAssignmentRule {
  id: string;
  priority: number;
  condition: string;      // JS expression (evaluated via guard-evaluator)
  result: string;         // target phase id
}

interface Transition {
  from: string;
  to: string;
  guard?: string | null;
  kind?: 'auto' | 'pass' | 'fail';
}

interface PhaseDef {
  dispatch?: { strategy: string; maxConcurrent?: number; overlapRoles?: string[] };
  stages?: StageDef[];
}

interface StageDef {
  id: string;
  allowedAgents?: string[];
  entryGuards?: string[];
  exitGuards?: string[];
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | ProfileMetadata Zod schema | Valid/invalid profile.json fixtures |
| Unit | ProfileSchema Zod schema | Valid/invalid YAML schema fixtures |
| Unit | ProfileLoader (discovery) | Temp dirs with profiles, empty dirs |
| Unit | Profile extends resolution | Valid chain, missing extends (fatal), circular extends |
| Unit | Schema extends resolution | Valid chain, cross-profile extends, circular extends |
| Unit | Schema merge logic per D3 table | Every field type's merge rule in isolation |
| Unit | Guard evaluator | JS expressions with session access, custom functions from guards.ts, sandbox isolation |
| Integration | resolveConfig end-to-end | Two-level extends (profile + schema) → verify merged output |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. This is a data-processing library (validate → resolve → merge).

## Migration / Rollout

No migration required. This is a new library with no existing runtime. Consumers adopt by installing the package and creating profile directories with metadata and schema files.

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Circular extends (profile metadata) | **First-encounter wins** — stop chain at repeat, use what was resolved so far | Detects cycle without rejecting the profile entirely; consumer gets partial resolution |
| Circular extends (schema) | **First-encounter wins** — same rule applies to schema extends chain | Consistent behavior across both levels |
| Profile file format | **JSON** for `profile.json`, **YAML** for schema files | JSON is simpler for metadata editing; YAML supports comments and multi-section structure for complex schemas |
| `HARNESS_PROFILE` env var | **Left to consumer** — the library does not read env vars | Keeps the library pure and testable; env integration is a consumer concern |
| Multiple schemas per profile | **Supported** — `schemas` array in metadata allows multiple independent YAML schema files | Profiles may need multiple state machine schemas; selection mechanism deferred |
