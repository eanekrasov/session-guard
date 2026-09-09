# Установка и запуск

Как подключить плагин к opencode, где он держит данные и как проверить, что он
работает.

Что он делает и почему — [architecture-overview.md](architecture-overview.md).
Как написать свой профиль — [profile-authoring.md](profile-authoring.md).

---

## Требования

opencode `>= 1.18.29` (объявлено в `engines`) и [bun](https://bun.sh) для сборки
и тестов.

---

## Подключение

Плагин экспортирует `default` — объект `{ id, server }`, где `server` и есть
хук-фабрика:

```typescript
// src/index.ts
export const SessionGuardPluginV1: Plugin = async (ctx: PluginInput) => {
  return createRuntime(ctx, { storeDir, profilesDir });
};

export default { id: 'session-guard', server: SessionGuardPluginV1 };
```

Подключается он как обычный плагин opencode — путём к собранному пакету либо к
исходникам:

```jsonc
// opencode.jsonc
{
  "plugin": ["file://путь/до/session-guard"],
}
```

Точный синтаксис поля `plugin` зависит от версии opencode; сверяйтесь с
конфигурацией своего checkout-а.

### Сборка

```bash
bun install
mise run build
```

Собирается два независимых артефакта:

| Файл                              | Что это                              |
| --------------------------------- | ------------------------------------ |
| `dist/index.js`                   | плагин и публичное API библиотеки    |
| `dist/tui.js`                     | TUI-модуль: боковая панель состояния |
| `dist/profile.schema.json`        | JSON Schema для `profile.json`       |
| `dist/profile-schema.schema.json` | JSON Schema для YAML-схемы workflow  |

`build:verify` проверяет, что все четыре на месте и что две точки входа не
перезаписали друг друга — такое однажды случилось молча.

В `package.json` они разведены по экспортам: `.` → `dist/index.js`,
`./tui` → `dist/tui.js`.

---

## Где лежат данные

**Профили** — `<project>/.opencode/profiles`, переопределяется
`SESSION_GUARD_PROFILES_DIR`. Корень `.opencode` меняется через
`OPENCODE_HARNESS_DIR`.

**Сессии** — `<XDG_DATA_HOME>/opencode/session-guard/runtime/<sessionId>.json`,
переопределяется `SESSION_GUARD_STORE_DIR`. Законченные сессии переезжают в
подкаталог `archive/` и перестают чем-либо управлять, оставаясь читаемыми.

Каталоги создаются при инициализации плагина. Значения вычисляются **на
экземпляр** и не пишутся в `process.env`: запись превращала локальный дефолт
первого проекта в глобальный, и второй проект получал чужие профили и сессии.

Полный список переменных — [configuration.md](configuration.md).

---

## На что плагин подписывается

| Хук                   | Что делает                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `chat.message`        | guardrails над сообщениями                                                                                  |
| `tool.execute.before` | допуск: guardrails, правила, согласие, задача, область записи, действия стадии, permit коммита, начало хода |
| `tool.execute.after`  | дифф, инварианты, вердикт, разбор `<workflow-result>`, переходы                                             |
| `event`               | уборка прерванных ходов                                                                                     |
| `dispose`             | освобождение ресурсов                                                                                       |

Плагин серверный. TUI — отдельный модуль (`dist/tui.js`), он только читает файлы
сессий и ничего не решает.

---

## Проверка, что всё работает

```bash
mise run check    # typecheck + lint + модульные тесты
mise run smoke    # прогон против живого opencode
```

`mise run smoke` поднимает настоящий opencode в изолированном временном каталоге,
проходит одиннадцать сценариев живой моделью и печатает результат по каждому.
Это единственная проверка, доказывающая, что механизм работает в продакшене, а
не что тесты согласны сами с собой: она уже находила дыры, которых не видели
полторы тысячи модульных тестов.

Полезные переменные прогона: `HOST_SMOKE_MODEL`, `HOST_SMOKE_ATTEMPTS`,
`HOST_SMOKE_DEBUG` (печатает шаги со временем, вопросы оператору и снимок
состояния при падении).

Один сценарий по имени:

```bash
mise run smoke verify-loop
```

---

## Dashboard

```bash
mise run dashboard
```

Порт `3456`. `DASHBOARD_TOKEN` включает Bearer-аутентификацию, `DASHBOARD_HOST`
меняет адрес (по умолчанию `127.0.0.1`), `ALLOWED_ORIGIN` — CORS. Показывает все
сессии, включая архивные.

---

## Первый workflow

1. Положите профиль в каталог профилей (или возьмите `base` из поставки).
2. Скажите агенту вызвать `workflow-create` с нужной схемой.
3. Дальше он ведёт вас по стадиям, а плагин следит за порядком.

Что означают отказы и где смотреть состояние —
[architecture-overview.md](architecture-overview.md), при затыке —
[troubleshooting.md](troubleshooting.md).
