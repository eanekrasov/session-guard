# Установка и запуск

Как подключить плагин к OpenCode, где он держит данные и как проверить, что он
работает. Важно не смешивать два контекста:

| Контекст                | Источник правды                                                | Где выполняются команды                              |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Source repository       | Этот checkout: `src/`, `scripts/`, `profiles/`, `.mise/tasks/` | В корне checkout-а плагина                           |
| Target OpenCode project | Проект пользователя и его `.opencode/`                         | В корне `<project>`; здесь плагин загружается хостом |

Сам по себе source checkout не является governed OpenCode project: запуск
OpenCode из него не загружает плагин автоматически.

Что он делает и почему — [architecture-overview.md](architecture-overview.md).
Как написать свой профиль — [profile-authoring.md](profile-authoring.md).

---

## Требования

В `package.json` заявлена совместимость с OpenCode `>= 1.18.29` (поле `engines`). Для
работы с source repository также нужен [mise](https://mise.jdx.dev/): он устанавливает
закреплённую версию Bun из `mise.toml` и запускает сборку и тесты через задачи.

---

## Подключение в target project

Плагин экспортирует `default` — объект `{ id, server }`, где `server` — фабрика
серверных хуков OpenCode. В target project его можно подключить тремя способами:

1. Клонировать checkout в `<project>/.opencode/session-guard` и подключить
   wrapper из `<project>/.opencode/plugins`.
2. Установить пакет как зависимость в `<project>/.opencode/package.json`.
3. Установить опубликованный пакет из npmjs:

   ```bash
   bun add @eanekrasov/session-guard
   # или
   npm i @eanekrasov/session-guard
   ```

   Пакет публичный и scoped (`publishConfig.access: public`), поэтому установка
   из npmjs не требует токена, `.npmrc` и доступа к GitHub Packages.
   Предварительные версии публикуются под тегом `next`:
   `npm i @eanekrasov/session-guard@next`.

Во всех случаях профили должны быть доступны в
`<project>/.opencode/profiles` либо через `SESSION_GUARD_PROFILES_DIR`.

Пример точки входа ниже относится к source repository; в target project
подключается опубликованный или собранный `dist`, а не путь `src/index.ts`:

```typescript
// src/index.ts
export const SessionGuardPluginV1: Plugin = async (ctx: PluginInput) => {
  return createRuntime(ctx, { storeDir, profilesDir });
};

export default { id: 'session-guard', server: SessionGuardPluginV1 };
```

Подключение в конфигурации OpenCode указывает на target-путь или пакет:

```jsonc
// opencode.jsonc
{
  "plugin": ["file://путь/до/session-guard"],
}
```

Точный синтаксис поля `plugin` зависит от версии OpenCode; сверяйтесь с
конфигурацией своего checkout-а.

### Сборка source repository

```bash
mise run setup
mise run build
```

Собираются три точки входа и две JSON Schema:

| Файл                              | Что это                                    |
| --------------------------------- | ------------------------------------------ |
| `dist/index.js`                   | плагин и публичное API библиотеки          |
| `dist/cli.js`                     | команды `sync-agents` и `validate-schemas` |
| `dist/tui.js`                     | TUI-модуль: боковая панель состояния       |
| `dist/profile.schema.json`        | JSON Schema для `profile.json`             |
| `dist/profile-schema.schema.json` | JSON Schema для YAML-схемы workflow        |

Последним шагом `mise run build` запускается `scripts/verify-build.ts`: он
проверяет наличие этих артефактов и то, что точки входа не перезаписали друг
друга.

В `package.json` точки входа разведены: по экспортам `.` → `dist/index.js` и
`./tui` → `dist/tui.js`, а `bin` публикует `dist/cli.js` под именем
`session-guard`.

CLI поддерживает `session-guard validate-schemas [--cwd <dir>]`: он разрешает
схемы всех профилей каталога профилей и запускает workflow compiler. По умолчанию
`--cwd` — текущий каталог; пути `OPENCODE_HARNESS_DIR` и
`SESSION_GUARD_PROFILES_DIR` учитываются так же, как при синхронизации агентов.
Код выхода `0` означает, что ошибки не найдены, `1` — ошибки схем, `2` — неверные
аргументы. Без команды сохраняется прежний запуск `sync-agents`.

Команды для схем и сессий:

```bash
session-guard sessions schemas [--cwd <dir>] [--json]
session-guard sessions list [--json]
session-guard sessions archived [--json]
session-guard sessions show <id> [--archived] [--json]
session-guard sessions restore <id>
session-guard sessions delete <id> [--archived]
session-guard sessions clear --archived --yes
session-guard sessions clear --all --yes
```

`sessions schemas` показывает profile/schema и описание из YAML. `sessions list`
показывает активные сессии, `sessions archived` — архивные; `sessions show <id>`
выводит полную запись одной активной сессии в JSON, а `--archived` выбирает
архивную. Сессии берутся из настроенного хранилища (по умолчанию — каталог
OpenCode state, переопределяемый `SESSION_GUARD_STORE_DIR`). `sessions restore`
перемещает архивную сессию обратно в активное хранилище и отказывается при
конфликте ID. `sessions delete` удаляет одну активную сессию; для удаления одной
архивной добавьте `--archived`.
`sessions clear --archived --yes` удаляет весь архив, а `sessions clear --all
--yes` — все активные и архивные сессии. Флаг `--yes` обязателен для этих
массовых операций.

Команды чтения `sessions list`, `sessions archived`, `sessions schemas` и
`sessions show` также принимают `--json`. Для списков CLI возвращает JSON-массив
записей; `sessions schemas --json` возвращает разрешённые профили и схемы. Этот
машинный вывод используется отдельным пакетом dashboard; обычный текстовый вывод
без `--json` сохранён.

---

## Где лежат данные

**Профили target project** — `<project>/.opencode/profiles`, переопределяются
`SESSION_GUARD_PROFILES_DIR`. В source repository поставляемые профили лежат в
`profiles/`, но source checkout не загружен как плагин автоматически. Корень
`.opencode` меняется через `OPENCODE_HARNESS_DIR`.

**Сессии** — `<XDG_DATA_HOME>/opencode/session-guard/runtime/<sessionId>.json`,
переопределяется `SESSION_GUARD_STORE_DIR`. Законченные сессии переезжают в
подкаталог `archive/` и перестают чем-либо управлять, оставаясь читаемыми.

Каталог сессий создаётся при инициализации плагина; каталог профилей должен уже
существовать. Значения вычисляются **на
экземпляр** и не пишутся в `process.env`: запись превращала локальный дефолт
первого проекта в глобальный, и второй проект получал чужие профили и сессии.

Полный список переменных — [configuration.md](configuration.md).

---

## На что плагин подписывается

| Хук                                    | Что делает                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `config`                               | регистрирует `sm-*` commands, служебного агента и синхронизирует profile agents                             |
| `chat.message`                         | guardrails и rules над сообщениями                                                                          |
| `tool.execute.before`                  | допуск: guardrails, правила, согласие, задача, область записи, действия стадии, permit коммита, начало хода |
| `tool.execute.after`                   | дифф и инварианты; результат гейта записывает агент вызовом `workflow-gate-set`; переходы                   |
| `event`                                | уборка прерванных ходов                                                                                     |
| `experimental.chat.system.transform`   | добавляет состояние workflow в system prompt                                                                |
| `experimental.session.compacting`      | добавляет workflow-контекст при compacting                                                                  |
| `experimental.chat.messages.transform` | передаёт преобразование сообщений rules-подсистеме                                                          |
| `dispose`                              | освобождение ресурсов                                                                                       |

Плагин серверный. TUI — отдельный модуль (`dist/tui.js`), он только читает файлы
сессий и ничего не решает.

---

## Проверка, что всё работает

```bash
mise run check    # typecheck + lint + модульные тесты
mise run smoke    # прогон против живого opencode
```

`mise run smoke` поднимает настоящий OpenCode в изолированном временном каталоге,
проходит текущие сценарии живой моделью и печатает результат по каждому.
Это единственная проверка, доказывающая, что механизм работает в продакшене, а
не что тесты согласны сами с собой: host smoke проверяет реальный hook/tool
pipeline, persistence и интеграцию с хостом.

Полезные переменные прогона: `HOST_SMOKE_MODEL`, `HOST_SMOKE_ATTEMPTS`,
`HOST_SMOKE_LOG_LEVEL=debug` (печатает шаги со временем, вопросы оператору и снимок
состояния при падении).

Один сценарий по имени:

```bash
mise run smoke verify-loop
```

---

## Отдельный пакет dashboard

```bash
mise run dashboard
```

Dashboard поставляется отдельно от `@eanekrasov/session-guard`, не запускается
внутри активной сессии OpenCode и получает сведения о сессиях через CLI. В source
repository `mise run dashboard` запускает пакет с CLI из исходников.
Dashboard — отдельный приватный пакет репозитория и не публикуется. Для локального
запуска ему нужны Bun и CLI `session-guard`; сервер слушает порт `3456`.
`DASHBOARD_TOKEN` включает Bearer-аутентификацию, `DASHBOARD_HOST` меняет адрес
(по умолчанию `127.0.0.1`), `ALLOWED_ORIGIN` задаёт CORS. Показывает все сессии,
включая архивные, из настроенного store.

---

## Первый workflow

1. Положите профиль в каталог профилей target project (или подключите
   поставляемые профили из source checkout).
2. Вызовите `workflow-create`: передайте `schemaId: "<profile>/<schema>"`, а
   для профиля с единственной schema можно передать только id профиля.
3. Дальше он ведёт вас по стадиям, а плагин следит за порядком.

Что означают отказы и где смотреть состояние —
[architecture-overview.md](architecture-overview.md), при затыке —
[troubleshooting.md](troubleshooting.md).
