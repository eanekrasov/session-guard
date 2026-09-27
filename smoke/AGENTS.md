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
