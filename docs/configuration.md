# Настройка

## Профили

Профиль объединяет metadata (`profile.json`) и одну или несколько workflow
schema. В текущем репозитории есть:

- `base` — базовый профиль;
- `android` — Kotlin/Compose workflow и проверки;
- `harness` — TypeScript workflow и проверки самого harness.

Профиль может наследовать другой профиль через `extends`.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `STATE_MACHINE_PROFILES_DIR` | Каталог профилей; по умолчанию `<project>/.opencode/profiles` |
| `STATE_MACHINE_STORE_DIR` | Каталог session state; переопределяет стандартный runtime-каталог |
| `OPENCODE_HARNESS_DIR` | Корень harness; по умолчанию `.opencode` |
| `HARNESS_PROFILE` | Профиль по умолчанию |
| `STATE_MACHINE_LOG_LEVEL` | Уровень логирования: `debug`, `info`, `warn`, `error` |
| `DASHBOARD_TOKEN` | Включает Bearer-аутентификацию dashboard |
| `DASHBOARD_HOST` | Адрес dashboard; по умолчанию `127.0.0.1` |
| `ALLOWED_ORIGIN` | Разрешённый CORS origin |

Пути можно задавать абсолютными или относительными; относительные пути
разрешаются относительно соответствующего корня проекта.

## Подключение

Плагин экспортирует `StateMachinePlugin` из `src/index.ts` и должен быть подключён
через конфигурацию OpenCode или локальный путь установки. Точный путь подключения
проверяйте в конфигурации конкретного OpenCode checkout.

## Dashboard

Dashboard запускается отдельным процессом:

```bash
bun run src/dashboard/dashboard-server.ts
```

По текущему серверному коду используется порт `3456`. Если задан
`DASHBOARD_TOKEN`, клиент должен передавать `Authorization: Bearer <token>`.
