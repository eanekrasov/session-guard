# Roadmap: State-Machine Plugin — Gap Analysis & Plan

> Сравнение плагина `plugins/state-machine/` со встроенным `state-machine/`
> в корне харнесса. Статус на 2026-08-30.

## Executive Summary

Плагин реализует ядро state-machine (Clean Architecture: data-layer,
session-store, domain-layer, plugin-runtime). Встроенный `state-machine/`
имеет ряд дополнительных компонентов и интеграций, которые плагин пока не
покрывает.

**Общий охват плагина: ~60%** функциональности встроенной версии.
Ключевые пробелы — hooks-интеграции (guardrails, consent, change-scope),
preset/config-driven ядро, profiles/инварианты, Beads-интеграция.

---

## 1. Компоненты плагина (уже есть)

| Компонент              | Встроенный           | Плагин                              | Статус       |
| ---------------------- | -------------------- | ----------------------------------- | ------------ |
| `WorkflowSession` типы | `store.ts`           | `src/session/types.ts`              | ✅ (упрощён) |
| `WorkflowStore`        | `store.ts`           | `src/session/session-store.ts`      | ✅           |
| `createSession()`      | `store.ts`           | `src/session/session-store.ts`      | ✅           |
| `derivePhase()`        | `state.ts`           | `src/domain/engine.ts`              | ✅           |
| `StateMachineEngine`   | `config-driven.ts`   | `src/domain/engine.ts`              | ✅           |
| `checkTransition()`    | `state.ts`           | `src/domain/validate-transition.ts` | ✅           |
| `GuardEvaluator`       | `guard-evaluator.ts` | `src/guard-evaluator.ts`            | ✅           |
| `SessionQueue`         | (встроен в runtime)  | `src/app/session-queue.ts`          | ✅           |
| Plugin entry point     | —                    | `src/plugin.ts`                     | ✅           |
| Profiles loader        | `profiles-loader.ts` | `src/profile-loader.ts`             | ✅           |
| Schema loader          | —                    | `src/schema-loader.ts`              | ✅ (экстра)  |
| Public API             | `preset-config.ts`   | `src/public-api.ts`                 | ✅           |

---

## 2. Недостающие компоненты

### 🔴 High Priority — блокируют замену

#### 2.1 Guardrails (безопасность)

**Встроенный:** `state-machine/guardrails.ts` — 6 категорий защит.
**Плагин:** отсутствует.
**Нужно:** порт `guardrails.ts` → `src/app/guardrails.ts`, интеграция в
`handleChatMessage` и `handleToolAfter`.

#### 2.2 Consent (согласие на план)

**Встроенный:** `state-machine/consent.ts` — парсинг `<consent-request>`,
SHA-256 evidence, классификация.
**Плагин:** отсутствует.
**Нужно:** порт `consent.ts`, интеграция в question-хуки.

#### 2.3 Change Scope (область изменений)

**Встроенный:** `state-machine/change-scope.ts` — git diff-based baseline.
**Плагин:** отсутствует.
**Нужно:** порт `change-scope.ts`, интеграция в `handleToolAfter`.

#### 2.4 SDD Artifacts (чтение/запись планов)

**Встроенный:** `state-machine/sdd-artifacts.ts` — `readPlanFile()`,
`computeSha256()`, `canonicalizePlan()`.
**Плагин:** отсутствует.
**Нужно:** порт в `src/app/sdd-artifacts.ts`.

#### 2.5 Invariants (валидация файлов)

**Встроенный:** `state-machine/invariants.ts` + профили.
**Плагин:** отсутствует.
**Нужно:** порт, интеграция в `handleFileToolAfter`.

### 🟡 Medium Priority

- **Манифесты задач** — `manifest.ts`
- ~~**Config-driven State Machine**~~ — сделано: YAML-схемы, `actions:` на стадии (бывший `actionGuards`), гейты объявляются профилем
- **Preset Config** — `resolveConfig()` с кешированием и мержем YAML
- **Beads Bridge** — `bd` CLI обёртка

### 🟢 Low Priority

- Config Schema, YAML-пресеты, пути

---

## 3. Отличия API и схем данных

### Runtime hooks

| Hook                  | Встроенный                                   | Плагин                       |
| --------------------- | -------------------------------------------- | ---------------------------- |
| `workflow.create`     | ✅ + preset                                  | ✅ + profileId               |
| `chat.message`        | ✅ guardrails                                | ✅ (логирование)             |
| `tool.execute.before` | ✅ guardrails + consent + git + task         | ✅ (Bash/Write guard только) |
| `tool.execute.after`  | ✅ consent + file val. + mutation + verifier | ✅ (finishMutation только)   |
| `event`               | ✅ live mutation cleanup                     | ✅                           |
| `dispose`             | ✅ dashboard + cleanup                       | ✅                           |

### WorkflowSession

Плагин использует упрощённую модель — без `commitPermit`, `baselineHashes`,
`changedFiles`, `invariantViolations`.

---

## 4. Приоритеты реализации

### Фаза 1 (Core Parity) — ~2-3 дня

1. **Guardrails** — prompt injection защита (блокирующий компонент)
2. **SDD Artifacts** — нужен для Consent
3. **Consent** — блокирует workflow approval
4. **Change Scope** — нужен для mutation validation

### Фаза 2 (Session Model) — ~1-2 дня

5. Расширение `WorkflowSession` — `commitPermit`, `baselineHashes`,
   `changedFiles`, `invariantViolations`
6. Полный `toSessionFacts()`

### Фаза 3 (Config & Profiles) — ~2-3 дня

7. Порт `preset-config.ts` с YAML-пресетами
8. Порт `config-driven.ts`
9. Инварианты

### Фаза 4 (Integration) — ~2 дня

10. Beads Bridge
11. Интеграция всех хуков
12. E2E тестирование

---

## 5. Тесты

Встроенная версия — **24 тестовых файла**. Плагин — тесты в
`plugins/state-machine/test/` (291 тест, >99% покрытие).

**Нужно добавить:**

- `test/app/guardrails.test.ts`
- `test/app/consent.test.ts`
- `test/app/change-scope.test.ts`
- `test/app/sdd-artifacts.test.ts`
- E2E тесты (плагин + harness)

---

_См. также: [plugin-architecture.md](./plugin-architecture.md) — описание
entry point, [usage.md](./usage.md) — подключение и настройка._
