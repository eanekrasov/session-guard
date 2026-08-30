# session-store Specification

## Purpose

Defines the `WorkflowStore` class and helper functions for persisting `WorkflowSession` to disk as JSON files.

## ADDED Requirements

### Requirement: WorkflowStore SHALL write session files to a directory

A store MUST be constructed as `new WorkflowStore(directory: string)` and SHALL keep every session file in that directory, one file per `sessionId`.

#### Scenario: Store creates directory on first save
- **WHEN** `save()` is called and the directory does not exist
- **THEN** the directory is created with `mkdir({ recursive: true })`

### Requirement: WorkflowStore.save SHALL use atomic write

Save SHALL write to a temporary file first, then rename to the final path. This prevents partial writes on crash.

#### Scenario: Atomic write on save
- **WHEN** `save(session)` is called
- **THEN** data is written to `<dir>/<encoded(sessionId)>.<pid>.<uuid>.tmp`, then renamed to `<dir>/<encoded(sessionId)>.json`
- **THEN** the temp file does not exist after the operation

#### Scenario: Temp file permissions
- **WHEN** temp file is created
- **THEN** it has mode `0o600` (owner read/write only)

### Requirement: WorkflowStore.save SHALL lock per sessionId

Concurrent `save()` calls for the same `sessionId` SHALL execute sequentially. Different sessionIds MAY write concurrently.

#### Scenario: Sequential saves for same session
- **WHEN** two `save()` calls are made for the same sessionId concurrently
- **THEN** they execute one after another, not in parallel

#### Scenario: Concurrent saves for different sessions
- **WHEN** two `save()` calls are made for different sessionIds
- **THEN** they MAY execute in parallel

### Requirement: WorkflowStore.save SHALL serialize session to JSON

The session SHALL be serialized with `JSON.stringify(session, null, 2)` plus a trailing newline.

#### Scenario: Save produces pretty-printed JSON
- **WHEN** `save(session)` is called
- **THEN** the written file contains `JSON.stringify(session, null, 2)` with a trailing newline

#### Scenario: Save with deeply nested session
- **WHEN** session contains nested objects (gates, approvals, tasks)
- **THEN** all fields are serialized correctly with 2-space indentation

### Requirement: WorkflowStore.load SHALL read session by sessionId

`load(sessionId: string): Promise<WorkflowSession | null>` — the load function SHALL read, parse, and validate a session file for the given sessionId.

#### Scenario: Load existing session
- **WHEN** a session file exists at `<dir>/<encoded(sessionId)>.json`
- **THEN** it is read, parsed via JSON, validated via Zod, and returned

#### Scenario: Load non-existent session
- **WHEN** no session file exists for the given sessionId
- **THEN** `null` is returned (no error thrown)

#### Scenario: Load corrupt file
- **WHEN** the session file contains invalid JSON
- **THEN** an error is thrown with a descriptive message

#### Scenario: Load file with unknown fields
- **WHEN** the session file contains fields not in the current schema
- **THEN** they are preserved through `.passthrough()`

### Requirement: WorkflowStore.save SHALL increment revision

Each successful save SHALL increment `session.revision` by 1.

#### Scenario: Revision increments on save
- **WHEN** `save(session)` is called with `revision: 0`
- **THEN** after save, `session.revision` is `1`

#### Scenario: Revision increments on subsequent saves
- **WHEN** `save(session)` is called twice
- **THEN** `session.revision` is `2` after the second save

### Requirement: WorkflowStore.save SHALL update updatedAt

Each successful save SHALL set `session.updatedAt` to the current ISO 8601 timestamp.

#### Scenario: updatedAt is set on save
- **WHEN** `save(session)` is called
- **THEN** `session.updatedAt` is a valid ISO 8601 timestamp

#### Scenario: updatedAt changes between saves
- **WHEN** `save(session)` is called twice with a delay
- **THEN** the second `updatedAt` is later than the first

### Requirement: WorkflowStore SHALL support special characters in sessionIds

Session IDs containing special characters (slashes, spaces, etc.) SHALL be encoded via `encodeURIComponent` for safe filenames.

#### Scenario: Session ID with slashes is encoded
- **WHEN** sessionId is `"root/sub/session"`
- **THEN** the filename is `encodeURIComponent("root/sub/session") + ".json"`

#### Scenario: Session ID with spaces is encoded
- **WHEN** sessionId is `"my session"`
- **THEN** the filename is `"my%20session.json"`

### Requirement: createSession SHALL produce a valid WorkflowSession

`createSession(sessionId: string, profileId: string): WorkflowSession`

#### Scenario: createSession returns session with defaults
- **WHEN** `createSession("session-123", "android")` is called
- **THEN** it returns a WorkflowSession with:
  - `sessionId: "session-123"`
  - `profileId: "android"`
  - `schemaVersion: 1`
  - `revision: 0`
  - `title: ""`
  - `testStatus: "pending"`
  - `commitPermit: { allowed: false }`
  - `commitHash: ""`
  - `bugVerified: false`
  - `baselineHashes: []`
  - `changedFiles: []`
  - `approvals: []` (empty array — new approvals use `ApprovalStep` with `type`, `evidence?`, `feedback?`)
  - `refs: {}`
  - `tasks: []`
  - `gates: CORE_GATES` (3 gates: invariants, review, qa — all `"pending"`, deep-copied)
  - `retryBudgets: { cycles: { attempts: 0, maximum: 3 } }`
  - `currentTaskIndex: 0`
  - `activeOperation: null`
  - `invariantViolations: []`
  - `updatedAt: <current ISO timestamp>`

#### Scenario: save/load roundtrip preserves all ApprovalStep fields
- **GIVEN** a session approved with `{ type: "plan", callId: "call-1", status: "granted", evidence: "sha256:abc", grantedAt: "2024-01-01T00:00:00.000Z" }`
- **AND** another session with `{ type: "plan", callId: "call-2", status: "denied", evidence: "sha256:def", feedback: "Missing test cases", grantedAt: "2024-01-01T00:01:00.000Z" }`
- **WHEN** both sessions are saved via `store.save()` and then loaded via `store.load()`
- **THEN** `type`, `callId`, `status`, `grantedAt`, `evidence`, and `feedback` are preserved exactly as written
- **THEN** `evidence` and `feedback` are `undefined` (not serialized) when not set, or the original string values when set

### Requirement: Helper functions SHALL mutate session in-place

All helper functions SHALL mutate the session object directly and MUST NOT return a new session (state-changing helpers return `void`).

#### Scenario: setGateStatus mutates the caller's session
- **GIVEN** a session with gate `invariants` at `"pending"`
- **WHEN** `setGateStatus(session, "invariants", "passed")` is called
- **THEN** the same session object now reports gate `invariants` as `"passed"` with a `resolvedAt` timestamp

#### getGate
`getGate(session: WorkflowSession, id: string): Gate | undefined`
- Returns the gate with matching `id`, or `undefined` if not found

#### setGateStatus
`setGateStatus(session: WorkflowSession, id: string, status: GateStatus): void`
- Finds gate by `id`, sets its `status`
- If status is `"passed"` or `"failed"`, sets `resolvedAt` to current ISO timestamp
- Does NOT set `resolvedAt` for `"pending"`, `"running"`, or `"skipped"` statuses
- Is a no-op if gate `id` is not found

#### bumpRetry
`bumpRetry(session: WorkflowSession, key: string): void`
- Increments `attempts` on `session.retryBudgets[key]`
- Creates `{ attempts: 1, maximum: 3 }` if key does not exist

#### isExhausted
`isExhausted(session: WorkflowSession, key: string): boolean`
- Returns `true` if `session.retryBudgets[key].attempts >= session.retryBudgets[key].maximum`
- Returns `false` if key does not exist

#### resetRetry
`resetRetry(session: WorkflowSession, key: string): void`
- Sets `session.retryBudgets[key].attempts` to `0`
- Creates `{ attempts: 0, maximum: 3 }` if key does not exist

#### setInvariantViolations
`setInvariantViolations(session: WorkflowSession, violations: Omit<InvariantViolationRecord, 'evidenceId'>[]): void`
- Replaces `session.invariantViolations` with the provided array
- Each violation gets a sequentially-assigned `evidenceId` (`"iv-1"`, `"iv-2"`, etc.) based on array index
- Clears all previous violations before setting new ones
