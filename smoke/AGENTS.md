# AGENTS.md — инструкции для агентов по работе с smoke-тестом

Это отдельный проект (`smoke/`), а не часть сборки плагина: исходники в
`smoke/src/`, тесты в `smoke/test/`, фикстуры профилей в `smoke/profile/`.

Код теста не связан с кодом плагина, поэтому:

- полный `mise run typecheck` не требуется
- полный `mise run check` не требуется
- полный `mise run test` не требуется
- полный `mise run build` не требуется

Единственная связь с корнем — фикстуры: suite читает `profiles/base`
(поставляемый набор) и `scripts/commit-task.ts` (копирует его в temp-проект).
Обратной связи нет: `smoke/**` не импортирует ничего за пределами `smoke/` — это
стережёт `no-restricted-imports` в `eslint.config.js`.

## Тесты

- Тесты smoke-suite находятся в `smoke/test/` и запускаются через Bun.
- Один файл: `bun test smoke/test/<имя-файла>.test.ts`.
- Весь smoke-набор: `bun test smoke/test/`.
- После изменений запускай затронутые тесты; полный корневой `mise run check` для
  проверки smoke-suite не нужен.

## Разбор JSONL-логов

Запуск smoke-suite сохраняет три JSONL-файла в каталоге
`.memory/host-smoke-logs/run-*/`: `suite.jsonl`, `host-v1.jsonl` и `host-v2.jsonl`.
Для фильтрации событий и вывода выбранных полей используй
`smoke/src/parse-jsonl.ts`:

```sh
bun run smoke/src/parse-jsonl.ts /path/to/run-directory/host-v2.jsonl \
  --level error --fields timestamp,sourceId,type,message
```

`--level` фильтрует по точному уровню (`trace`, `debug`, `info`, `warn`, `error`),
а `--fields` выводит перечисленные поля верхнего уровня. Вывод остаётся JSONL в stdout.
Полная справка: `bun run smoke/src/parse-jsonl.ts --help`.
