# Spec: marker-refactoring

## Общие требования

### R1. Переименование типов и полей

Все переименования должны удовлетворять:

- **R1.1**: Ни одно поле `WorkflowSession` не должно содержать термины `plan`, `bug`, `commit` в именах
- **R1.2**: Все публичные функции должны использовать обобщённые глаголы (approve/decline/confirm/reject) вместо сущностных (approvePlan/markBugVerified)
- **R1.3**: GuardEvaluator должен предоставлять два метода чтения: `session.approved(type)` и `session.confirmed(stage)`
- **R1.4**: Zod-схемы должны валидировать новые имена полей. Старые имена — отвергаться (strip)

## Требования по модулям

### R2. session/types.ts

- **R2.1**: Удалить интерфейс `CommitPermit`
- **R2.2**: Добавить интерфейс `Verification` с полями: `stage: string`, `status: VerificationStatus`, `verifiedAt?: string`, `evidence?: string`
- **R2.3**: Добавить тип `VerificationStatus = 'pending' | 'confirmed' | 'failed'`
- **R2.4**: Поле `WorkflowSession.commitPermit` — удалить
- **R2.5**: Поле `WorkflowSession.commitHash` → `deliveryReceipt`
- **R2.6**: Поле `WorkflowSession.bugVerified` → `verifications: Verification[]`
- **R2.7**: Поле `WorkflowSession.baselineHashes` → `scopeSnapshot`
- **R2.8**: Поле `WorkflowSession.changedFiles` → `modifiedArtifacts`
- **R2.9**: Тип `InvariantViolationRecord` → `ValidationRecord`
- **R2.10**: Поле `WorkflowSession.invariantViolations` → `validationRecords: ValidationRecord[]`
- **R2.11**: `retryBudgets` default key `cycles` → `mutation` (остаётся `Record<string, RetryBudget>`)

### R3. session/session-schema.ts

- **R3.1**: Удалить `CommitPermitSchema`
- **R3.2**: Добавить `VerificationSchema` с полями из R2.2
- **R3.3**: `WorkflowSessionSchema` — обновить поля согласно R2.4–R2.11
- **R3.4**: Schema должна reject старые имена (strip mode)

### R4. session/session-store.ts

- **R4.1**: `createSession()` — обновить defaults под R2.4–R2.11
- **R4.2**: `setInvariantViolations()` → `setValidationRecords()`
- **R4.3**: `createSession()` — default retry key: `mutation` вместо `cycles`

### R5. domain/workflow.ts

- **R5.1**: `approvePlan()` → `approve(session, type, evidence, callId)`
- **R5.2**: `declinePlan()` → `decline(session, type, evidence, callId, feedback)`
- **R5.3**: `markBugVerified()` → `confirm(session, stage, status?, evidence?)`
- **R5.4**: Удалить `PLAN_APPROVAL_TYPE`
- **R5.5**: `finishMutation()` — параметр `changedFiles` → `modifiedArtifacts`
- **R5.6**: `finishMutation()` — `bumpRetry(session, 'cycles')` → `bumpRetry(session, 'mutation')`
- **R5.7**: `beginMutation()` — удалить `session.bugVerified = false`, заменить на `session.verifications = []` или `reject(session, ...)`

### R6. domain/session-facts.ts

- **R6.1**: `SessionFacts.bugVerified` → `SessionFacts.verifications: Verification[]`
- **R6.2**: `SessionFacts.commitHash` → `SessionFacts.deliveryReceipt`
- **R6.3**: `SessionFacts.commitPermit` удалён, но должен быть доступен через `approved('commit')`

### R7. guard-evaluator.ts

- **R7.1**: `enhanceWithGranted()` → `enhanceSession()` (или нейтральное имя)
- **R7.2**: В Proxy добавить `approved(type)` и `confirmed(stage)`
- **R7.3**: `granted(type)` — удалить

### R8. profiles/session-guard.yaml

- **R8.1**: `session.granted('plan')` → `session.approved('plan')`
- **R8.2**: `session.commitPermit exists` → `session.approved('commit')`
- **R8.3**: `session.commitHash exists` → `session.deliveryReceipt exists`
- **R8.4**: `session.planDeclined == true` → `not session.approved('plan')`

### R9. Публичный API (index.ts)

- **R9.1**: Заменить `approvePlan` / `declinePlan` / `markBugVerified` на `approve` / `decline` / `confirm`
- **R9.2**: Убрать `PLAN_APPROVAL_TYPE` из экспорта
- **R9.3**: Убрать `CommitPermitSchema` / `CommitPermit` из экспорта
- **R9.4**: Обновить barrel exports в `domain/index.ts`

## Сценарии

### S1. Approve план (бывший approvePlan)

**Given** session без approvals для type='plan'
**When** `approve(session, 'plan', 'ev-1', 'call-1')` 
**Then** `session.approvals` содержит `{ type: 'plan', callId: 'call-1', status: 'granted', evidence: 'ev-1' }`

### S2. Decline план (бывший declinePlan)

**Given** session без approvals для type='plan'
**When** `decline(session, 'plan', 'ev-1', 'call-1', 'bad plan')`
**Then** `session.approvals` содержит `{ type: 'plan', callId: 'call-1', status: 'denied', evidence: 'ev-1', feedback: 'bad plan' }`

### S3. Approve commit (бывший commitPermit)

**Given** session без approvals для type='commit'
**When** `approve(session, 'commit', 'ev-2', 'call-2')`
**Then** guard-expression `session.approved('commit')` возвращает `true`

### S4. Confirm verification (бывший markBugVerified)

**Given** session без verifications для stage='bug'
**When** `confirm(session, 'bug')`
**Then** `session.verifications` содержит `{ stage: 'bug', status: 'confirmed', verifiedAt: <ISO> }`

### S5. Guard Evaluator approved() в Proxy

**Given** session с approval `{ type: 'plan', status: 'granted' }`
**When** guard-expression `"session.approved('plan')"` evaluated
**Then** возвращает `true`

### S6. Guard Evaluator confirmed() в Proxy

**Given** session с verification `{ stage: 'bug', status: 'confirmed' }`
**When** guard-expression `"session.confirmed('bug')"` evaluated
**Then** возвращает `true`

### S7. Reject verification

**Given** session с verification `{ stage: 'bug', status: 'confirmed' }`
**When** `reject(session, 'bug')`
**Then** `session.verifications` содержит `{ stage: 'bug', status: 'failed' }`

### S8. YAML consistency

**Given** profiles/session-guard.yaml
**Then** Все guard-выражения используют `session.approved('')` и `session.confirmed('')`
**Then** Нет вхождений `granted`, `commitPermit`, `commitHash`, `planDeclined`

### S9. Schema migration compatibility

**Given** сохранённый JSON сессии со старыми полями (`changedFiles`, `bugVerified`, и т.д.)
**When** `WorkflowSessionSchema.parse(raw)` через `.strip()`
**Then** Старые поля отбрасываются, возвращаются дефолты для новых полей (или partial)
**Note**: Это может сломать восстановление сессии. Решение — либо миграция, либо `passthrough().partial()`
