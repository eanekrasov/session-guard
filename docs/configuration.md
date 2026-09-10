# Настройка

## Контексты

В source repository переменные и команды относятся к разработке плагина. В
target OpenCode project runtime получает `projectDir` от OpenCode и читает
профили из `.opencode/`; отсутствие этих target-путей в source checkout не
является ошибкой.

## Профили

Профиль объединяет metadata (`profile.json`) и одну или несколько workflow
schema. В текущем репозитории есть:

- `base` — базовый профиль;
- `android` — Kotlin/Compose workflow и проверки;
- `harness` — TypeScript workflow и проверки самого harness.

Профиль может наследовать другой профиль через `extends`.

Поставляемые исходники профилей находятся в `profiles/` source repository. При
установке в target project их нужно разместить в каталоге профилей target project
или явно указать `SESSION_GUARD_PROFILES_DIR`.

## Переменные окружения

| Переменная                   | Назначение                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `SESSION_GUARD_PROFILES_DIR` | Каталог профилей; по умолчанию `<project>/.opencode/profiles`                               |
| `SESSION_GUARD_STORE_DIR`    | Каталог session state; переопределяет стандартный runtime-каталог                           |
| `OPENCODE_HARNESS_DIR`       | Корень harness; по умолчанию `.opencode`                                                    |
| `HARNESS_SCHEMA_ID`          | Fallback для `workflow-create`, например `android` или `android/custom`                     |
| `HARNESS_PROFILE`            | Второй fallback для `workflow-create`, если не задан `HARNESS_SCHEMA_ID`                    |
| `SESSION_GUARD_LOG_LEVEL`    | Уровень логирования: `debug`, `info`, `warn`, `error`                                       |
| `HARNESS_AUTO_APPROVE`       | При `true` автоматически выдаёт запрошенное consent; только для автоматизированных прогонов |
| `XDG_DATA_HOME`              | База OpenCode state directory; по умолчанию `~/.local/share`                                |
| `DASHBOARD_TOKEN`            | Включает Bearer-аутентификацию dashboard                                                    |
| `DASHBOARD_HOST`             | Адрес dashboard; по умолчанию `127.0.0.1`                                                   |
| `ALLOWED_ORIGIN`             | Разрешённый CORS origin                                                                     |

`OPENCODE_HARNESS_DIR` может быть абсолютным или относительным: относительный
путь разрешается относительно директории target project. Значения
`SESSION_GUARD_PROFILES_DIR` и `SESSION_GUARD_STORE_DIR` используются как
заданные; для переносимой конфигурации указывайте абсолютные пути.

Для выбора schema при `workflow-create` действует порядок: аргумент инструмента,
`HARNESS_SCHEMA_ID`, затем `HARNESS_PROFILE`. Неквалифицированное значение
выбирает профиль с таким id и работает только если у профиля ровно одна schema;
при нескольких schema укажите `<profile>/<schema>`.

## Подключение

Плагин экспортирует `SessionGuardPluginV1` из `src/index.ts` и должен быть подключён
через конфигурацию OpenCode или локальный путь установки. Точный путь подключения
проверяйте в конфигурации конкретного OpenCode checkout.

## Dashboard

Dashboard запускается отдельным процессом в source repository:

```bash
mise run dashboard
```

У target project нет автоматически создаваемого dashboard-процесса. Если сервер
запускается из checkout-а плагина, передайте ему `SESSION_GUARD_PROFILES_DIR` и
`SESSION_GUARD_STORE_DIR` target project; иначе сервер из source repository
будет искать собственные значения по умолчанию. Сервер использует порт `3456`.
Если задан `DASHBOARD_TOKEN`, клиент должен передавать
`Authorization: Bearer <token>`; `ALLOWED_ORIGIN` задаёт CORS.
