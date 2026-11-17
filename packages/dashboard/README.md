# Session Guard Dashboard

Отдельный Bun-пакет для веб-панели сессий. Плагин OpenCode не запускает и не
содержит dashboard; панель получает сессии и схемы через `session-guard --json`.

Пакет предназначен для локального запуска из checkout-а и не публикуется.
Запуск из корня репозитория:

```bash
mise run dashboard
```

Dashboard использует `SESSION_GUARD_STORE_DIR` и `SESSION_GUARD_PROFILES_DIR`
из окружения CLI. HTTP-порт — `3456`; адрес и доступ настраиваются через
`DASHBOARD_HOST`, `DASHBOARD_TOKEN` и `ALLOWED_ORIGIN`.
