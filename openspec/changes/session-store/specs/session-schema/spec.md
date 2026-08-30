# session-schema Specification

## Purpose

Defines the Zod schema for `WorkflowSession` — the persisted entity representing a single workflow run. The schema validates session data on load and ensures type safety for all fields, nested types, and helper functions.

## ADDED Requirements

### Requirement: WorkflowSession Zod schema SHALL validate all fields

The schema SHALL define a Zod object with the following fields:

| Field | Type | Validation |
|-------|------|------------|
| `schemaVersion` | `z.number()` | Optional — `.passthrough()` allows unknown future versions |
| `sessionId` | `z.string()` | Required — non-empty |
| `revision` | `z.number()` | Required — non-negative integer |
| `profileId` | `z.string()` | Required — non-empty |
| `title` | `z.string()` | Optional — defaults to `""` |
| `gates` | `z.array(GateSchema)` | Optional — defaults to `[]` |
| `approvals` | `z.array(ApprovalStepSchema)` | Optional — defaults to `[]` |
| `refs` | `z.record(z.string())` | Optional — defaults to `{}` |
| `tasks` | `z.array(PlanTaskSchema)` | Optional — defaults to `[]` |
| `currentTaskIndex` | `z.number()` | Optional — defaults to `0` |
| `activeOperation` | `ActiveOperationSchema.nullable()` | Optional — defaults to `null` |
| `testStatus` | `z.enum(['pending', 'running', 'completed', 'failed', 'skipped'])` | Optional — defaults to `'pending'` |
| `commitPermit` | `CommitPermitSchema` | Optional — defaults to `{ allowed: false }` |
| `commitHash` | `z.string()` | Optional — defaults to `""` |
| `retryBudgets` | `z.record(RetryBudgetSchema)` | Optional — defaults to `{}` |
| `updatedAt` | `z.string()` | Optional — defaults to current ISO 8601 timestamp |
| `bugVerified` | `z.boolean()` | Optional — defaults to `false` |
| `baselineHashes` | `z.array(z.string())` | Optional — defaults to `[]` |
| `changedFiles` | `z.array(z.string())` | Optional — defaults to `[]` |
| `invariantViolations` | `z.array(InvariantViolationRecordSchema)` | Optional — defaults to `[]` |
| `phaseOverride` | `z.string().nullable()` | Optional — defaults to `null` |
| `preset` | `z.string()` | Optional — defaults to `undefined` |

#### Scenario: Valid session passes validation
- **WHEN** a WorkflowSession object with `sessionId` and `profileId` is validated
- **THEN** it passes Zod schema validation with defaults applied

#### Scenario: Missing optional fields get defaults
- **WHEN** a session object has no `tasks`, `gates`, or `approvals`
- **THEN** the Zod schema fills defaults: empty arrays, empty strings, or `false` as defined above

#### Scenario: Unknown fields are stripped via `.strip()`
- **WHEN** a session object contains unknown top-level fields
- **THEN** they are stripped from the output

#### Scenario: phaseOverride defaults to null
- **WHEN** a session object has no `phaseOverride` field
- **THEN** validation sets it to `null`

#### Scenario: preset is optional
- **WHEN** a session object has no `preset` field
- **THEN** validation passes without error and `preset` is `undefined`

### Requirement: WorkflowSession SHALL use `.passthrough()` on load and `.strip()` on save

The Zod schema SHALL use `.strip()` for save path validation. On the load path, `WorkflowStore.load()` calls `.passthrough()` to preserve unknown fields from future schema versions.

#### Scenario: Strip removes unknown fields on save
- **WHEN** a session object with unknown fields is validated for save
- **THEN** the unknown fields are stripped from the output

#### Scenario: Passthrough preserves unknown fields on load
- **WHEN** a session object with unknown fields is loaded from disk
- **THEN** the unknown fields are preserved through `.passthrough()`

### Requirement: ApprovalStepSchema SHALL validate approval steps

The schema SHALL validate the `ApprovalStep` interface with `type`, `callId`, `status` (one of three valid values), optional `grantedAt`, optional `evidence`, and optional `feedback`.

```typescript
interface ApprovalStep {
  type: string;
  callId: string;
  status: "pending" | "granted" | "denied";
  grantedAt?: string;      // ISO timestamp
  evidence?: string;        // cryptographic digest of the approved content
  feedback?: string;        // rejection reason (used only when status is "denied")
}
```

#### Scenario: Approval step with all standard fields
- **WHEN** approval step has `type`, `callId`, and valid `status`
- **THEN** validation passes

#### Scenario: Approval step with optional evidence and feedback
- **WHEN** approval step has `type: "plan"`, `callId: "call-1"`, `status: "denied"`, `evidence: "sha256:abc"`, and `feedback: "Missing tests"`
- **THEN** validation passes and all fields are present in the output

#### Scenario: Approval step with type + evidence (granted)
- **WHEN** approval step has `type: "plan"`, `callId: "call-1"`, `status: "granted"`, `evidence: "sha256:abc"`, and no `feedback`
- **THEN** validation passes and `feedback` is `undefined`

#### Scenario: Approval step missing type
- **WHEN** approval step has `callId` and `status` but no `type`
- **THEN** validation fails with a descriptive error

#### Scenario: Approval step missing callId
- **WHEN** approval step has no `callId` field
- **THEN** validation fails with a descriptive error

#### Scenario: Approval step with invalid status
- **WHEN** approval step status is not one of `"pending"`, `"granted"`, `"denied"`
- **THEN** validation fails

#### Scenario: Empty type is rejected
- **WHEN** approval step has `type: ""`, `callId: "c"`, `status: "pending"`
- **THEN** validation fails because `z.string().min(1)` requires non-empty `type`

#### Scenario: Empty callId is rejected
- **WHEN** approval step has `type: "plan"`, `callId: ""`, `status: "pending"`
- **THEN** validation fails because `z.string().min(1)` requires non-empty `callId`

### Requirement: GateSchema SHALL validate gate objects

The schema SHALL validate the `Gate` interface with `id`, `status` (one of five valid values), and optional `resolvedAt`.

```typescript
interface Gate {
  id: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  label?: string;         // Human-readable label
  resolvedAt?: string;     // ISO timestamp
}
```

#### Scenario: Valid gate
- **WHEN** gate has `id` and valid `status`
- **THEN** validation passes

#### Scenario: Gate with label
- **WHEN** gate has `id`, valid `status`, and `label: "Invariants check"`
- **THEN** validation passes and label is present in the output

#### Scenario: Invalid gate status
- **WHEN** gate status is not one of the valid enum values (e.g. `"pass"` or `"fail"`)
- **THEN** validation fails

### Requirement: ActiveOperationSchema SHALL validate active operations

The schema SHALL validate the `ActiveOperation` interface with `mutationId`, `startedAt`, `status`, and optional `result`.

```typescript
interface ActiveOperation {
  mutationId: string;
  startedAt: string;       // ISO timestamp
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
}
```

#### Scenario: Valid active operation passes validation
- **WHEN** an ActiveOperation object has `mutationId`, valid `startedAt`, and valid `status`
- **THEN** validation passes

#### Scenario: ActiveOperation with invalid status fails
- **WHEN** an ActiveOperation has status `"invalid"`
- **THEN** validation fails

### Requirement: CommitPermitSchema SHALL validate commit permits

The schema SHALL validate the `CommitPermit` interface with `allowed`, and optional `reason` and `grantedAt`.

```typescript
interface CommitPermit {
  allowed: boolean;
  reason?: string;
  grantedAt?: string;      // ISO timestamp
}
```

#### Scenario: Valid commit permit passes validation
- **WHEN** a CommitPermit object has `allowed: true`
- **THEN** validation passes

#### Scenario: Commit permit without allowed field fails
- **WHEN** a CommitPermit object has no `allowed` field
- **THEN** validation fails

### Requirement: RetryBudgetSchema SHALL validate retry budgets

The schema SHALL validate the `RetryBudget` interface with `attempts` (non-negative integer) and `maximum` (positive integer, min 1).

```typescript
interface RetryBudget {
  attempts: number;        // non-negative integer
  maximum: number;         // positive integer (min 1)
}
```

#### Scenario: Valid retry budget passes validation
- **WHEN** a RetryBudget object has `attempts: 0` and `maximum: 3`
- **THEN** validation passes

#### Scenario: Retry budget with negative attempts fails
- **WHEN** a RetryBudget object has `attempts: -1`
- **THEN** validation fails

### Requirement: PlanTaskSchema SHALL validate plan tasks

The schema SHALL validate the `PlanTask` interface with `id`, `title`, `status`, and optional `assignedTo`.

```typescript
interface PlanTask {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  assignedTo?: string;
}
```

#### Scenario: Valid plan task passes validation
- **WHEN** a PlanTask object has `id`, `title`, and valid `status`
- **THEN** validation passes

#### Scenario: Plan task with invalid status fails
- **WHEN** a PlanTask has status `"invalid"`
- **THEN** validation fails

### Requirement: InvariantViolationRecordSchema SHALL validate violation records

The schema SHALL validate the `InvariantViolationRecord` interface with `evidenceId`, `severity`, `message`, and `status`.

```typescript
interface InvariantViolationRecord {
  evidenceId: string;
  severity: "critical" | "warning" | "info";
  message: string;
  status: "open" | "resolved";
}
```

#### Scenario: Valid violation record passes validation
- **WHEN** an InvariantViolationRecord has `evidenceId`, valid `severity`, `message`, and valid `status`
- **THEN** validation passes

#### Scenario: Violation record with invalid severity fails
- **WHEN** severity is not one of `"critical"`, `"warning"`, `"info"`
- **THEN** validation fails
