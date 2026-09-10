# Диагностика

Сначала определите контекст: команды `mise run ...` относятся к source
repository, а `<project>/.opencode/**` — к target OpenCode-проекту. Отсутствие
target path в source checkout само по себе не является причиной сбоя.

## Workflow не создаётся

Проверьте выбранный `profileId`/`schemaId` и `SESSION_GUARD_PROFILES_DIR`. Для
`workflow-create` приоритет имеют аргумент `schemaId`, затем
`HARNESS_SCHEMA_ID`, затем `HARNESS_PROFILE`. Неназванный schema через один
`profileId` допустим только если в profile ровно одна schema.

Если каталог пуст, создайте или подключите `profile.json` и schema в target project.
Для source checkout поставочные профили лежат в `profiles/`; это не default
target path.

## Schema не загружается

Проверьте YAML-синтаксис, имена разделов, обязательные поля dispatch и сообщения
ошибки profile loader. Используйте [schema-reference.md](schema-reference.md).

## Переход заблокирован

Проверьте текущую стадию, guard, незавершённые gates, approval и статус задач.
Graph-связь между стадиями не гарантирует разрешённый переход.

## Approval не применяется

Проверьте, что `workflow-consent.type` совпадает с именем `consent` на переходе,
решение относится к текущему запросу и перечисленные файлы/evidence не были
изменены после показа вопроса. Без `type` используется имя `plan`.

## QA возвращает workflow назад

Исправьте причину failure и проверьте retry budget. После исчерпания лимита
workflow может перейти в terminal failure.

## TUI или dashboard не обновляет состояние

Проверьте каталог session store, ID сессии и время последнего обновления. Для
dashboard отдельно проверьте, что сервер запущен на ожидаемом порту и что token
передаётся корректно.

Dashboard запускается в source repository через `mise run dashboard` и читает
тот же store, что и runtime. По умолчанию store находится в глобальном каталоге
OpenCode; при `SESSION_GUARD_STORE_DIR` это значение должно совпадать у runtime
и dashboard. Порт по умолчанию — `3456`; при удалённом или браузерном доступе
проверьте также `DASHBOARD_HOST`, `DASHBOARD_TOKEN` и `ALLOWED_ORIGIN`.

## Что приложить при обращении за помощью

- текущий профиль;
- название schema;
- текущую стадию и сообщение блокировки;
- последние логи без секретов;
- минимальный воспроизводимый пример schema.
