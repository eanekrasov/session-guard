# Design: Session Store — WorkflowSession persistence

## Technical Approach

Add three modules under `src/session/` — `types.ts`, `session-schema.ts`, `session-store.ts` — that implement WorkflowSession persistence as JSON files on disk. The store wraps Node.js `fs/promises` with atomic writes (temp-file + rename), per-key sequential locking (promise chain keyed by sessionId), and Zod validation on load. Helper functions are module-level exports that mutate a session in-place, keeping the class focused on I/O.

This is a new library leaf — no existing code changes, no migration, no feature flags. The plugin starts with empty state, so schema versioning is reserved but unused.

## Architecture Decisions

### D1: File structure — three files under `src/session/`

| Option | Tradeoff |
|--------|----------|
| **Chosen: three files** (types.ts + session-schema.ts + session-store.ts) | Clear separation: types vs schema vs I/O. Matches `src/schema/` layout. |
| Single file `session.ts` | Too crowded (~400 lines with types, schema, store, helpers). |
| Nest under `src/session/` subdirs | Over-engineered for one module. |

**Rationale**: Mirrors the existing `src/schema/` convention (types.ts, profile-metadata.ts, profile-schema.ts), where types, Zod schema, and operational logic live in separate files within the same directory.

### D2: WorkflowStore as a class (not free functions)

| Option | Tradeoff |
|--------|----------|
| **Chosen: `WorkflowStore` class** | Carries `directory` config; namespace for load/save. Matches parent project pattern. |
| Free functions with directory param | Same capability, but no grouping — every caller passes the directory. |

**Rationale**: The class carries the target directory as constructor state, avoiding repetition. This matches the project's existing class pattern (e.g., loader-like modules in `src/schema-loader.ts`).

### D3: Per-key locking via promise chain (`Map<string, Promise<void>>`)

| Option | Tradeoff |
|--------|----------|
| **Chosen: Promise chain per sessionId** | Each sessionId gets its own sequential queue. Different IDs run in parallel. |
| Global mutex | Simple but serializes all writes, even unrelated sessions. |
| File-level `flock` | Cross-platform, but requires fd management and `node:fs` (not promises). |

**Rationale**: A `Map<string, Promise<void>>` where each `save()` appends to the previous promise via `.then()` is a zero-dependency pattern. The previous promise resolves when the prior write is complete. This gives per-key sequential ordering with no external libraries.

### D4: Atomic write — temp file with pid+uuid, rename, mode `0o600`

| Option | Tradeoff |
|--------|----------|
| **Chosen: `writeFile(tmp)` → `rename(tmp, target)`** | POSIX-atomic on same filesystem. Prevents partial reads. |
| `writeFile(target)` directly | Crash mid-write leaves a truncated file that `load()` will reject. |
| `copyFile` then `unlink` | Two operations, not atomic. |

**Rationale**: `rename()` is atomic on POSIX when source and target are on the same filesystem. The temp path includes `process.pid` and `crypto.randomUUID()` for uniqueness. Mode `0o600` prevents other system users from reading workflow session data.

### D5: Schema passthrough strategy — `strip()` for save, `passthrough()` for load

| Option | Tradeoff |
|--------|----------|
| **Chosen: `.strip()` on schema, `.passthrough()` on load** | `save()` writes only known fields. `load()` preserves unknown fields for forward compat. |
| `.passthrough()` everywhere | Unknown fields written back to disk, potentially carrying stale data. |
| `.strict()` everywhere | Unknown fields rejected — breaks forward compatibility. |

**Rationale**: On save, `.strip()` ensures only fields the current version knows about hit the disk. On load, `.passthrough()` silently carries forward any extra fields a future version may have written. The schema object is defined once with `.strip()`; the load path uses `.passthrough()` as a post-parse step before type assertion.

### D6: Helper functions as module-level exports, mutating session in-place

| Option | Tradeoff |
|--------|----------|
| **Chosen: Free functions, mutable session arg** | Simple signatures, no `this`. Caller explicitly sees mutation. |
| Class methods on WorkflowStore | Store becomes a god class mixing I/O and business logic. |
| Immutable — return new session | Creates GC pressure; callers must re-assign. |

**Rationale**: Helpers (`getGate`, `setGateStatus`, `bumpRetry`, etc.) are pure data manipulation with no I/O. They belong as exported functions from `session-schema.ts` (co-located with the schema), mutating the session in-place. The proposal explicitly says "no return value for state changes."

### D7: `CORE_GATES` as `const` array

```typescript
export const CORE_GATES = [
  { id: 'invariants', status: 'pending' as const },
  { id: 'review', status: 'pending' as const },
  { id: 'qa', status: 'pending' as const },
] satisfies Gate[];
```

`GateStatus` values: `'pending' | 'running' | 'passed' | 'failed' | 'skipped'` — note the past participle forms, matching the domain layer's `GateStatus` type.

**Rationale**: Used as default value for `gates` in `createSession()`. Being a `const` array prevents accidental mutation at the module level. The `satisfies` keyword ensures type-level compatibility with `Gate[]` without widening the literal types.

### D8: Evidence IDs sequentially assigned by `setInvariantViolations`

```
evidenceId = `iv-${i + 1}`
```

The function takes `Omit<InvariantViolationRecord, 'evidenceId'>[]` and assigns `evidenceId` based on array index (`iv-1`, `iv-2`, ...), replacing all previous violations.

**Rationale**: Evidence IDs are derived from position (index + 1), not session state, so the function is pure with respect to its input. Violations are always replaced in batch — never appended individually — so there are no gaps or duplicates.

### D9: JSON serialization — `JSON.stringify(session, null, 2) + '\n'`

**Rationale**: Pretty-printed JSON for human readability during debugging. Trailing newline is POSIX convention for text files and makes the file compatible with `cat`, `head`, and git diff expectations.

### D10: Session file naming — `encodeURIComponent(sessionId) + '.json'`

**Rationale**: Session IDs (from OpenCode) may contain slashes, spaces, or other characters unsafe in filenames. `encodeURIComponent` maps them to valid URL-encoded strings. A sessionId like `"my session/1"` becomes `"my%20session%2F1.json"`.

### D11: Revision increment on save

**Rationale**: Each successful `save()` increments `session.revision += 1`. This gives callers a monotonic counter to detect concurrent modification (read-save-read cycles) without file-level locking.

### D12: `updatedAt` set on save

**Rationale**: Each `save()` sets `session.updatedAt = new Date().toISOString()`. This lets downstream consumers (UI, logs, monitoring) know when a session was last persisted without inspecting filesystem mtime.

## Data Flow

```
save(session) flow:

  Caller ──→ WorkflowStore.save(session)
                  │
                  ├── increment revision
                  ├── set updatedAt
                  ├── strip unknown fields via Schema
                  ├── JSON.stringify(session, null, 2) + "\n"
                  │
                  ├── acquire lock (sessionId promise chain)
                  │     │
                  │     └── writeFile(tmpPath, data, { mode: 0o600 })
                  │           │
                  │           └── rename(tmpPath, targetPath)
                  │                 │
                  │                 └── release lock (resolve promise)
                  │
                  └── return

load(sessionId) flow:

  Caller ──→ WorkflowStore.load(sessionId)
                  │
                  ├── existsSync(targetPath)? ──no──→ return null
                  │     │ yes
                  │     ▼
                  ├── readFile(targetPath, "utf-8")
                  │     │
                  │     ├── JSON.parse(data) ──error──→ throw Error("descriptive")
                  │     │
                  │     └── Schema.passthrough().parse(json)
                  │           │
                  │           └── return WorkflowSession
                  │
                  └── return
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/session/types.ts` | Create | All WorkflowSession nested interfaces and union types |
| `src/session/session-schema.ts` | Create | Zod schemas for all types + `CORE_GATES` + helper functions |
| `src/session/session-store.ts` | Create | `WorkflowStore` class (load, save, createSession), per-key locking, atomic write |
| `src/index.ts` | Modify | Re-export new public types, schemas, and WorkflowStore |
| `test/session-schema.test.ts` | Create | Zod validation tests + helper function tests |
| `test/session-store.test.ts` | Create | WorkflowStore unit + integration tests with temp dirs |

## Interfaces / Contracts

```typescript
// ─── src/session/types.ts ─────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'granted' | 'denied';
export type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type Severity = 'critical' | 'warning' | 'info';
export type ViolationStatus = 'open' | 'resolved';

export interface ApprovalStep {
  type: string;
  callId: string;
  status: ApprovalStatus;
  grantedAt?: string;      // ISO 8601
  evidence?: string;        // cryptographic digest of the approved content
  feedback?: string;        // rejection reason (used when status is "denied")
}

export interface Gate {
  id: string;
  status: GateStatus;
  label?: string;     // Human-readable label
  resolvedAt?: string;     // ISO 8601
}

export interface ActiveOperation {
  mutationId: string;
  startedAt: string;       // ISO 8601
  status: TaskStatus;
  result?: string;          // "output_ready" or free-form
}

export interface CommitPermit {
  allowed: boolean;
  reason?: string;
  grantedAt?: string;      // ISO 8601
}

export interface RetryBudget {
  attempts: number;
  maximum: number;
}

export interface PlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignedTo?: string;
}

export interface InvariantViolationRecord {
  evidenceId: string;
  severity: Severity;
  message: string;
  status: ViolationStatus;
}

export interface WorkflowSession {
  schemaVersion: number;
  sessionId: string;
  revision: number;
  profileId: string;
  title: string;
  gates: Gate[];
  approvals: ApprovalStep[];
  refs: Record<string, string>;
  tasks: PlanTask[];
  currentTaskIndex: number;
  activeOperation: ActiveOperation | null;
  testStatus: TaskStatus;
  commitPermit: CommitPermit;
  commitHash: string;
  retryBudgets: Record<string, RetryBudget>;
  updatedAt: string;       // ISO 8601
  bugVerified: boolean;
  baselineHashes: string[];
  changedFiles: string[];
  invariantViolations: InvariantViolationRecord[];
  phaseOverride: string | null;
  preset?: string;
}

// ─── src/session/session-schema.ts ────────────────────────────────────────────

import { z } from 'zod';
import type { Gate, GateStatus, InvariantViolationRecord, WorkflowSession } from './types.ts';

const GATE_STATUS = ['pending', 'running', 'passed', 'failed', 'skipped'] as const;
const TASK_STATUS = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;

export const ApprovalStepSchema = z.object({
  type: z.string().min(1),
  callId: z.string().min(1),
  status: z.enum(['pending', 'granted', 'denied']),
  grantedAt: z.string().optional(),
  evidence: z.string().optional(),
  feedback: z.string().optional(),
});

export const GateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(GATE_STATUS),
  resolvedAt: z.string().optional(),
});

export const ActiveOperationSchema = z.object({
  mutationId: z.string().min(1),
  startedAt: z.string().min(1),
  status: z.enum(TASK_STATUS),
  result: z.string().optional(),
});

export const CommitPermitSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  grantedAt: z.string().optional(),
});

export const RetryBudgetSchema = z.object({
  attempts: z.number().int().min(0),
  maximum: z.number().int().min(1),
});

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(TASK_STATUS),
  assignedTo: z.string().optional(),
});

export const InvariantViolationRecordSchema = z.object({
  evidenceId: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']),
  message: z.string().min(1),
  status: z.enum(['open', 'resolved']),
});

export const WorkflowSessionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  sessionId: z.string().min(1),
  revision: z.number().int().min(0).default(0),
  profileId: z.string().min(1),
  title: z.string().default(''),
  gates: z.array(GateSchema).default([]),
  approvals: z.array(ApprovalStepSchema).default([]),
  refs: z.record(z.string()).default({}),
  tasks: z.array(PlanTaskSchema).default([]),
  currentTaskIndex: z.number().int().min(0).default(0),
  activeOperation: ActiveOperationSchema.nullable().default(null),
  testStatus: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']).default('pending'),
  commitPermit: CommitPermitSchema.default({ allowed: false }),
  commitHash: z.string().default(''),
  retryBudgets: z.record(RetryBudgetSchema).default({}),
  updatedAt: z.string().default(() => new Date().toISOString()),
  bugVerified: z.boolean().default(false),
  baselineHashes: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  invariantViolations: z.array(InvariantViolationRecordSchema).default([]),
}).strip();

// ─── CORE_GATES ────────────────────────────────────────────────────────────────

export const CORE_GATES = [
  { id: 'invariants', status: 'pending' as const },
  { id: 'review', status: 'pending' as const },
  { id: 'qa', status: 'pending' as const },
] satisfies Gate[];

// ─── Helper functions ──────────────────────────────────────────────────────────

export function getGate(session: WorkflowSession, id: string): Gate | undefined {
  return session.gates.find((g) => g.id === id);
}

export function setGateStatus(session: WorkflowSession, id: string, status: GateStatus): void {
  const gate = session.gates.find((g) => g.id === id);
  if (!gate) return;
  gate.status = status;
  if (status === 'passed' || status === 'failed') {
    gate.resolvedAt = new Date().toISOString();
  }
}

export function bumpRetry(session: WorkflowSession, key: string): void {
  if (!session.retryBudgets[key]) {
    session.retryBudgets[key] = { attempts: 0, maximum: 3 };
  }
  session.retryBudgets[key].attempts++;
}

export function isExhausted(session: WorkflowSession, key: string): boolean {
  const budget = session.retryBudgets[key];
  return budget ? budget.attempts >= budget.maximum : false;
}

export function resetRetry(session: WorkflowSession, key: string): void {
  session.retryBudgets[key] = { attempts: 0, maximum: 3 };
}

export function setInvariantViolations(
  session: WorkflowSession,
  violations: Omit<InvariantViolationRecord, 'evidenceId'>[]
): void {
  session.invariantViolations = violations.map((violation, index) => ({
    ...violation,
    evidenceId: `iv-${index + 1}`,
  }));
}

// ─── src/session/session-store.ts ─────────────────────────────────────────────

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { WorkflowSessionSchema, CORE_GATES } from './session-schema.ts';
import type { WorkflowSession } from './types.ts';

export class WorkflowStore {
  private directory: string;
  private locks = new Map<string, Promise<void>>();

  constructor(directory: string) {
    this.directory = directory;
  }

  async load(sessionId: string): Promise<WorkflowSession | null> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return null;

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `[ERROR] Failed to read session file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`[ERROR] Corrupt session file: invalid JSON`);
    }

    const result = WorkflowSessionSchema.passthrough().safeParse(parsed);
    if (!result.success) {
      throw new Error(`[ERROR] Corrupt session file: ${result.error.issues.map((i) => i.message).join('; ')}`);
    }
    return result.data as WorkflowSession;
  }

  async save(session: WorkflowSession): Promise<void> {
    session.revision++;
    session.updatedAt = new Date().toISOString();
    const clean = WorkflowSessionSchema.parse(session);
    const json = JSON.stringify(clean, null, 2) + '\n';
    const targetPath = this.sessionPath(session.sessionId);
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

    const key = session.sessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const withIo = prev
      .then(() => mkdir(this.directory, { recursive: true }))
      .then(() => writeFile(tmpPath, json, { mode: 0o600 }))
      .then(() => rename(tmpPath, targetPath));

    // Capture the chain for this key so writers see the correct lock
    const chain = withIo.then(() => {
      // Clean up lock entry if this chain is still the active one
      if (this.locks.get(key) === chain) {
        this.locks.delete(key);
      }
    });

    this.locks.set(key, chain);
    return chain.catch(() => { /* Swallow — errors propagate through the returned promise */ });
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.directory, `${encodeURIComponent(sessionId)}.json`);
  }
}

// ─── createSession factory ────────────────────────────────────────────────────

export function createSession(sessionId: string, profileId: string): WorkflowSession {
  return {
    schemaVersion: 1,
    sessionId,
    profileId,
    revision: 0,
    title: '',
    gates: CORE_GATES.map((g) => ({ ...g })),
    approvals: [],
    refs: {},
    tasks: [],
    currentTaskIndex: 0,
    activeOperation: null,
    testStatus: 'pending',
    commitPermit: { allowed: false },
    commitHash: '',
    retryBudgets: { cycles: { attempts: 0, maximum: 3 } },
    updatedAt: new Date().toISOString(),
    bugVerified: false,
    baselineHashes: [],
    changedFiles: [],
    invariantViolations: [],
  };
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit — Zod schemas | Each schema validates/invalidates per the spec scenarios | `WorkflowSessionSchema.parse(valid)` passes; missing `type` on ApprovalStep fails; invalid `GateStatus` fails; unknown fields stripped on parse |
| Unit — helpers | `getGate`, `setGateStatus`, `bumpRetry`, `isExhausted`, `resetRetry`, `setInvariantViolations` | Direct calls on a known session object; verify mutations and return values |
| Unit — evidenceId | `setInvariantViolations` assigns `iv-N` IDs | Call with 3 violations → IDs are `iv-1`, `iv-2`, `iv-3` |
| Integration — WorkflowStore | `save` then `load` roundtrip | Temp dir fixture. Save a session, load it back, assert all fields match. |
| Integration — atomic write | Temp file cleaned up after save | Assert no `.tmp` files remain in the session dir. |
| Integration — load non-existent | Returns `null` | `load('nonexistent')` → `null` |
| Integration — load corrupt JSON | Throws `Error` | Write garbage to session file, `load()` → throws with descriptive message |
| Integration — concurrency | Sequential saves for same ID, parallel for different IDs | Fire 3 concurrent `save()` calls for same sessionId → revision is 3. Fire for different IDs → both complete. |
| Integration — directory auto-create | First save creates dir | Save to non-existent dir → file is written, dir exists |
| Integration — permissions | Temp file mode `0o600` | Stat temp file during save (with race margin) or verify via `chmod`-readable test |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The only I/O boundary is local file read/write, which is covered by the integration tests above (corrupt file, directory permissions, concurrent access, atomic write).

| Threat | Probability | Mitigation | Test Coverage |
|--------|------------|------------|---------------|
| File corruption on crash during write | Low | Atomic rename; temp on same FS | Temp file assertion |
| Concurrent writes to same session | Low | Per-key promise chain | Revision sequencing test |
| Directory doesn't exist | Low | `mkdir({ recursive: true })` on first save | Auto-create test |
| Corrupt existing file on read | Low | Fail-closed — `JSON.parse` throws descriptive error | Corrupt file test |
| Non-existent file on load | Low | Return `null` (no error) | Load missing test |
| Session ID with unsafe filename chars | Low | `encodeURIComponent` | Not explicitly tested (std lib) |

## Migration / Rollout

No migration required. This is a new library — no existing data to migrate. The `schemaVersion` field is set to 1 and reserved for future use. No feature flags, no phased rollout.

## Open Questions

None.
