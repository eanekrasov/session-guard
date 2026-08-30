# Proposal: Session Store — WorkflowSession persistence

## Intent

Add a persistence module for `WorkflowSession` — the entity representing a workflow run's state. The module saves and loads sessions as JSON files on disk, with atomic writes and per-key sequential locking.

Unlike config-layer (which reads configs), session-store manages runtime data: creation, loading, saving, and helper functions for gate and retry budget operations. Schema versioning and migrations are not planned — the plugin starts fresh.

## Scope

### In Scope
- `WorkflowSession` — full-structure interface (schemaVersion, sessionId, gates, tasks, mutations, etc.)
- Zod schema for WorkflowSession — validation on load
- `WorkflowStore` — class with `load()`, `save()`, `createSession()`
- Atomic writes (temp file + rename)
- Per-key sequential locking (promise chain per sessionId)
- Helper functions: `getGate`, `setGateStatus`, `bumpRetry`, `isExhausted`, `resetRetry`, `setInvariantViolations`
- Tests (unit + integration with temp directories)

### Out of Scope
- Schema versioning and migrations — plugin starts fresh
- State derivation — Domain Layer, next change
- Workflow orchestration (`workflow.ts`) — Domain Layer
- Dispatch — Domain Layer
- Plugin runtime integration — Application Layer

### Dependencies
- Node.js built-ins: `node:fs/promises`, `node:fs` (existsSync), `node:path`, `node:crypto`
- `zod` — already pulled in by config-layer
- No external dependencies

## WorkflowSession Fields

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `number` | Always 1 for now. Reserved for future migrations. Not strictly validated on load — `.passthrough()` on the Zod schema. |
| `sessionId` | `string` | OpenCode session ID, used as filename and key for load/save |
| `revision` | `number` | Monotonically increasing change counter |
| `approvals` | `ApprovalStep[]` | Steps requiring operator confirmation (plan, commit, etc.) |
| `refs` | `Record<string, string>` | Associative map of artifact references (plan, spec, etc.) |
| `tasks` | `PlanTask[]` | Plan task array |
| `currentTaskIndex` | `number \| null` | Index of the active task |
| `activeOperation` | `ActiveOperation \| null` | Current mutation |
| `gates` | `Gate[]` | Gate array |
| `commitPermit` | `CommitPermit` | Commit permission (default `{ allowed: false }`) |
| `commitHash` | `string` | Commit hash (empty string if none) |
| `testStatus` | `TaskStatus` | Task execution status (default `'pending'`) |
| `retryBudgets` | `Record<string, RetryBudget>` | Retry attempt budgets |
| `updatedAt` | `string` | ISO 8601 timestamp |
| `bugVerified` | `boolean` | Bug confirmed |
| `baselineHashes` | `string[]` | File baseline hashes |
| `changedFiles` | `string[]` | Changed files |
| `title` | `string` | Session title |
| `profileId` | `string` | Active profile ID (from config-layer) |
| `invariantViolations` | `InvariantViolationRecord[]` | Invariant violations |

### Nested Types

| Type | Fields |
|------|--------|
| `ApprovalStep` | type (string), callId (string), status (pending/granted/denied), grantedAt?, evidence?, feedback? |
| `Gate` | id (string), status (pending/running/passed/failed/skipped), resolvedAt? |
| `ActiveOperation` | mutationId (string), startedAt (ISO), status (TaskStatus), result? |
| `CommitPermit` | allowed (boolean), reason?, grantedAt? |
| `RetryBudget` | attempts (number), maximum (number) |
| `PlanTask` | id (string), title (string), status (TaskStatus), assignedTo? |
| `InvariantViolationRecord` | evidenceId (string), severity (critical/warning/info), message (string), status (open/resolved) |
| `ApprovalStatus` | "pending" \| "granted" \| "denied" |
| `GateStatus` | "pending" \| "running" \| "passed" \| "failed" \| "skipped" |
| `TaskStatus` | "pending" \| "running" \| "completed" \| "failed" \| "skipped" |
| `Severity` | "critical" \| "warning" \| "info" |
| `ViolationStatus` | "open" \| "resolved" |

## WorkflowStore Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(directory: string)` | Stores the directory path |
| `load` | `(sessionId: string) => Promise<WorkflowSession \| null>` | Reads file, parses JSON. Returns null if file doesn't exist. |
| `save` | `(session: WorkflowSession) => Promise<void>` | Atomic write via temp + rename. Per-key sequential lock. |

### Factory

| Function | Signature | Description |
|----------|-----------|-------------|
| `createSession` | `(sessionId: string, profileId: string) => WorkflowSession` | Factory with all defaults |

### Helper Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `getGate` | `(session, id: string) => Gate \| undefined` | Find gate by ID |
| `setGateStatus` | `(session, id: string, status: GateStatus) => void` | Set gate status, set `resolvedAt` on pass/fail |
| `bumpRetry` | `(session, key: string) => void` | Increment attempts (creates with max=3 if missing) |
| `isExhausted` | `(session, key: string) => boolean` | `attempts >= maximum` |
| `resetRetry` | `(session, key: string) => void` | Reset attempts to 0 |
| `setInvariantViolations` | `(session, violations: Omit<InvariantViolationRecord, 'evidenceId'>[]) => void` | Replace violations array, assigning `iv-N` evidence IDs |

## Key Design Decisions

1. **Schema version = 1**: Start at 1. Migration function is a stub ready for extension.
2. **Per-key sequential locking**: Promise chain per sessionId. Different sessions write in parallel; one session writes sequentially.
3. **Atomic writes**: temp `<path>.<pid>.<uuid>.tmp` → `rename(temp, path)`. POSIX atomicity.
4. **Fail-closed on corrupt JSON**: `JSON.parse` error → throws `Error` with description, no recovery attempts.
5. **No external dependencies**: Only Node.js built-in modules + `zod`.
6. **schemaVersion present, migration deferred**: Field exists, Zod schema uses `.passthrough()` for unknown fields. `WorkflowStore.load()` does not strictly check the version — logs a warning on unknown version but does not fail. Migration mechanism will be added when real files of different versions appear.

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Concurrent writes to same session | Low | Per-key sequential lock |
| File corruption on crash during write | Low | Atomic rename, temp on same FS |
| Corrupt session file on read | Low | Fail-closed — error with description |
| Breaking changes in Zod schema when adding fields | Medium | `.passthrough()` on unknown fields on load; old files are read, new fields get defaults |
