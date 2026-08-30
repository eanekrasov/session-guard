# Proposal: marker-refactoring

**Type**: Refactoring (implementation-specific naming → domain-agnostic naming)
**Scope**: All layers — session types, domain workflow, guard evaluator, public API

## Motivation

В AGENTS.md зафиксированы маркеры слишком частной реализации (implementation-specific naming).
Плагин завязан на терминологию OpenCode-харнесса (`bugVerified`, `commitPermit`, `commitHash`,
`changedFiles`, `invariantViolations`, `cycles`, `PLAN_APPROVAL_TYPE`, `approvePlan`, `markBugVerified`).

Каждый маркер — это точка связности с конкретной реализацией. Другие клиенты (Claude Code, Codex)
имеют другую терминологию, и плагин должен работать с ними без переименования полей.

## Scope

**48 вхождений** маркеров в **12 файлах**. Изменения проходят через все слои:

- `src/session/types.ts` — data model (6 полей)
- `src/session/session-schema.ts` — Zod schema (6 полей + CommitPermitSchema)
- `src/session/session-store.ts` — factory + helpers
- `src/domain/workflow.ts` — 4 публичные функции + константа
- `src/domain/session-facts.ts` — проекция (SessionFacts)
- `src/guard-evaluator.ts` — Proxy (approved, confirmed вместо granted)
- `src/domain/derive-phase.ts`, `src/domain/engine.ts` — импорты
- `src/index.ts`, `src/domain/index.ts` — публичный API
- `profiles/state-machine.yaml` — guard-выражения

**Не затрагивает**: application layer (`src/app/runtime.ts`, `session-queue.ts`) — только импорты.

## Change Map

### 1. Approvals: approvePlan/declinePlan → approve/decline + PLAN_APPROVAL_TYPE удалён

| Было | Стало |
|------|-------|
| `approvePlan(session, evidence, callId)` | `approve(session, type, evidence, callId)` |
| `declinePlan(session, evidence, callId, feedback)` | `decline(session, type, evidence, callId, feedback)` |
| `PLAN_APPROVAL_TYPE = 'plan'` | удалён (type передаётся параметром) |
| `session.granted('plan')` | `session.approved('plan')` |

### 2. CommitPermit → Approval с type='commit'

| Было | Стало |
|------|-------|
| `CommitPermit` интерфейс | удалён |
| `CommitPermitSchema` | удалён |
| `session.commitPermit: CommitPermit` | удалён из WorkflowSession |
| `session.commitPermit exists` (YAML) | `session.approved('commit')` |
| Установка commitPermit внешним кодом | `approve(session, 'commit', callId, evidence)` |

### 3. bugVerified → Verification[]

| Было | Стало |
|------|-------|
| `bugVerified: boolean` | `verifications: Verification[]` |
| `markBugVerified(session)` | `confirm(session, stage, evidence?)` |
| `session.bugVerified = false` в beginMutation | `reject(session, stage)` или удалить запись |
| `session.bugVerified == true` (guard) | `session.confirmed('bug')` |
| `SessionFacts.bugVerified` | `SessionFacts.verifications` |

### 4. changedFiles → modifiedArtifacts

Простое переименование поля + параметра в `finishMutation`.

### 5. baselineHashes → scopeSnapshot

Простое переименование поля.

### 6. invariantViolations → validationRecords

Переименование типа `InvariantViolationRecord` → `ValidationRecord`,
функции `setInvariantViolations` → `setValidationRecords`.

### 7. cycles → mutation (ключ retryBudgets)

| Было | Стало |
|------|-------|
| `retryBudgets: { cycles: {...} }` (createSession) | `retryBudgets: { mutation: {...} }` |
| `bumpRetry(session, 'cycles')` (finishMutation) | `bumpRetry(session, 'mutation')` |

### 8. commitHash → deliveryReceipt

| Было | Стало |
|------|-------|
| `commitHash: string \| null` | `deliveryReceipt: string \| null` |
| `session.commitHash exists` (YAML) | `session.deliveryReceipt exists` |
| `SessionFacts.commitHash` | `SessionFacts.deliveryReceipt` |

### 9. GuardEvaluator: granted → approved + confirmed

| Было | Стало |
|------|-------|
| `enhanceWithGranted()` | `enhanceSession()` или `createContextProxy()` |
| `session.granted(type)` | `session.approved(type)` |
| (отсутствует) | `session.confirmed(stage)` |

### 10. YAML guard-выражения (profiles/state-machine.yaml)

| Было | Стало |
|------|-------|
| `session.granted('plan')` | `session.approved('plan')` |
| `session.commitPermit exists` | `session.approved('commit')` |
| `session.commitHash exists` | `session.deliveryReceipt exists` |
| `session.planDeclined == true` | `not session.approved('plan')` (или удалить, если не используется) |

## Dependencies

- **data-layer** — не зависит (pure types)
- **session-store** — data model меняется
- **domain-layer** — workflow functions + facts меняются
- **plugin-runtime** — только импорты (runtime не меняет логику)

## Risks

1. **Schema migration**: сохранённые JSON-файлы сессий содержат старые имена полей.
   Нужно либо мигрировать, либо добавить compatibility слой.
2. **plugin-runtime imports**: runtime.ts импортирует approvePlan, markBugVerified — нужно
   обновить импорты.
3. **Guard-выражения в сохранённых профилях**: если пользователь написал свой YAML
   со старыми именами — сломается. Хотя на данном этапе это только `profiles/state-machine.yaml`.

## Recommendation

Одобрить для SDD spec/design/tasks.
