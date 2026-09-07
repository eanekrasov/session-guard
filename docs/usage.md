# Usage: State-Machine Plugin в Harness

> Как использовать плагин вместо встроенного `state-machine/`.

## Status

Плагин **уже подключён** в `opencode.jsonc` (строка 24):

```json
"plugin": ["file://plugins/state-machine/src/plugin.ts"]
```

OpenCode загружает его по этому пути напрямую. `package.json["main"]`
(`./src/plugin.ts`) — для npm-установленных копий.

На данный момент **плагин не заменяет полностью** встроенный
`state-machine/runtime.ts` — см. [roadmap.md](./roadmap.md) для списка
недостающих компонентов (guardrails, consent, change-scope, invariants и др.).

**Текущее состояние**: плагин загружается OpenCode параллельно со встроенной
версией, но та остаётся основным workflow-движком. Плагин предоставляет
`createRuntime()`, чистую модульную архитектуру и покрытие тестами >99%.

---

## Архитектура подключения

### Плагин

Плагин реализует интерфейс `@opencode-ai/plugin` (`Plugin`):

```typescript
// src/plugin.ts
export const StateMachinePlugin: Plugin = async (ctx: PluginInput) => {
  return createRuntime(ctx); // Возвращает Hooks
};
```

OpenCode загружает его через `opencode.jsonc` или package.json:

```json
"plugin": ["file://plugins/state-machine/src/plugin.ts"]
```

### Встроенная версия (текущий production)

Встроенный `state-machine/runtime.ts` — набор awaited-хуков, вызываемых
напрямую из кода харнесса. Он **не является** стандартным Plugin.

---

## Entry point

- `src/plugin.ts` — `"main"` в package.json, как у beads
- `package.json["exports"]["."]` → `dist/index.js` — для npm
- TUI вынесен в `tui-plugins/sidebar-state.tsx`

---

## Переменные окружения

| Переменная                   | По умолчанию                         | Описание                            |
|------------------------------|--------------------------------------|-------------------------------------|
| `STATE_MACHINE_STORE_DIR`    | `{harnessDir}/state-machine/runtime` | Директория для session store        |
| `STATE_MACHINE_PROFILES_DIR` | —                                    | Директория с profile-конфигами      |
| `HARNESS_PROFILE`            | —                                    | Активный профиль (android, harness) |
| `OPENCODE_HARNESS_DIR`       | `.opencode`                          | Базовый каталог харнесса            |

---

## Быстрый старт разработки

```bash
cd plugins/state-machine

# Тесты
bun test
bun test --coverage

# Конкретный файл
bun test test/app/runtime.test.ts

# Watch
bun test --watch

# Сборка библиотеки
bun run build

# Типчекинг
bun run typecheck
```
