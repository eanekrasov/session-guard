# Tasks: marker-refactoring

## Execution Mode

- **Mode**: strict TDD — write/modify test first, then implementation
- **Test framework**: vitest (`bun test`)
- **PR strategy**: single PR
- **Review budget**: 1200 lines

## Phase 1: Types & Schemas

### Task 1.1 — session/types.ts: Update interfaces ✅

**Files**: `src/session/types.ts`
**Tests**: `test/session/session-schema.test.ts` (дополнить), `test/session/session-helpers.test.ts` (дополнить)

**Changes**:
1. Удалить `CommitPermit` interface
2. Удалить `InvariantViolationRecord` → `ValidationRecord` (rename)
3. Добавить `Verification` и `VerificationStatus`
4. `WorkflowSession`:
   - Удалить `commitPermit`
   - `commitHash` → `deliveryReceipt`
   - `bugVerified` → `verifications: Verification[]`
   - `baselineHashes` → `scopeSnapshot`
   - `changedFiles` → `modifiedArtifacts`
   - `invariantViolations` → `validationRecords: ValidationRecord[]`

**Verification**: `bun test` — все тесты, обновлённые до новых типов, проходят

### Task 1.2 — session/session-schema.ts: Update Zod schemas ✅

**Files**: `src/session/session-schema.ts`
**Tests**: `test/session/session-schema.test.ts`

**Changes**:
1. Удалить `CommitPermitSchema`
2. `InvariantViolationRecordSchema` → `ValidationRecordSchema`
3. Добавить `VerificationSchema`
4. `WorkflowSessionSchema` — обновить поля под Task 1.1
5. Default retry key: `cycles` → `mutation`

**Verification**: `bun test` — тесты schema проходят

## Phase 2: Storage

### Task 2.1 — session/session-store.ts: Update factory + helpers ✅

**Files**: `src/session/session-store.ts`
**Tests**: `test/session/session-helpers.test.ts`

**Changes**:
1. `createSession()` — defaults под новые поля Task 1.1
2. `setInvariantViolations()` → `setValidationRecords()`
3. Default retry key: `cycles` → `mutation`

**Verification**: `bun test` — session helpers проходят

## Phase 3: Domain Logic

### Task 3.1 — domain/workflow.ts: Обобщить функции ✅

**Files**: `src/domain/workflow.ts`
**Tests**: `test/domain/workflow.test.ts`

**Changes**:
1. `approvePlan()` → `approve(session, type, evidence, callId)`
2. `declinePlan()` → `decline(session, type, evidence, callId, feedback)`
3. `markBugVerified()` → `confirm(session, stage, status?, evidence?)`
4. Новая: `reject(session, stage, evidence?)`
5. Удалить `PLAN_APPROVAL_TYPE`
6. `finishMutation()` — `changedFiles` → `modifiedArtifacts`
7. `finishMutation()` — `bumpRetry(session, 'cycles')` → `bumpRetry(session, 'mutation')`
8. `beginMutation()` — `session.bugVerified = false` → `session.verifications = []`

**Verification**: `bun test` — workflow тесты проходят

### Task 3.2 — domain/session-facts.ts: Update projection ✅

**Files**: `src/domain/session-facts.ts`
**Tests**: `test/domain/session-facts.test.ts`

**Changes**:
1. `SessionFacts.bugVerified` → `SessionFacts.verifications`
2. `SessionFacts.commitHash` → `SessionFacts.deliveryReceipt`
3. Удалить `SessionFacts.commitPermit`
4. `toSessionFacts()` — обновить проекцию

**Verification**: `bun test` — session-facts тесты проходят

### Task 3.3 — domain/engine.ts + domain/derive-phase.ts: Update imports ✅

**Files**: `src/domain/engine.ts`, `src/domain/derive-phase.ts`
**Tests**: `test/domain/engine.test.ts`, `test/domain/derive-phase.test.ts`

**Changes**: Только обновление типов — функции не меняются.

**Verification**: `bun test` — engine + derive-phase проходят

## Phase 4: Guard Evaluator

### Task 4.1 — guard-evaluator.ts: Add approved/confirmed ✅

**Files**: `src/guard-evaluator.ts`
**Tests**: `test/guard-evaluator.test.ts`

**Changes**:
1. `enhanceWithGranted()` → `enhanceSession()`
2. Proxy — удалить `granted`, добавить `approved(type)` и `confirmed(stage)`

**Verification**: `bun test` — guard-evaluator проходят

## Phase 5: Public API

### Task 5.1 — domain/index.ts + src/index.ts: Update re-exports ✅

**Files**: `src/domain/index.ts`, `src/index.ts`
**Changes**:
1. `approvePlan` / `declinePlan` / `markBugVerified` → `approve` / `decline` / `confirm` / `reject`
2. Убрать `PLAN_APPROVAL_TYPE`
3. Убрать `CommitPermitSchema` / `CommitPermit`
4. Добавить `Verification`, `VerificationStatus`, `ValidationRecord`

**Verification**: `bun test` — compile проверка

## Phase 6: Configuration

### Task 6.1 — profiles/state-machine.yaml: Update guard expressions ✅

**Files**: `profiles/state-machine.yaml`

**Changes**:
1. `session.granted()` → `session.approved()`
2. `session.commitPermit exists` → `session.approved('commit')`
3. `session.commitHash exists` → `session.deliveryReceipt exists`
4. `session.planDeclined == true` → `not session.approved('plan')`

**Verification**: Configuration parse прогон (integration test)

## Phase 7: App layer imports

### Task 7.1 — src/app/runtime.ts: Update imports ✅

**Files**: `src/app/runtime.ts`
**Changes**: `approvePlan` / `markBugVerified` → `approve` / `confirm` (если импортируются)

**Verification**: `bun build` — сборка проходит

## Forecast

| Phase | Files | Tests | Risk |
|-------|-------|-------|------|
| 1. Types & Schemas | 2 src + 2 test | 27 | Low |
| 2. Storage | 1 src + 1 test | 14 | Low |
| 3. Domain Logic | 4 src + 4 test | 45 | Medium |
| 4. Guard Evaluator | 1 src + 1 test | 8 | Medium |
| 5. Public API | 2 src | — | Low |
| 6. Configuration | 1 YAML | — | Low |
| 7. App layer | 1 src | — | Low |
