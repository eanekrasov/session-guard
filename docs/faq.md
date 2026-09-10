# FAQ

### Почему в source checkout нет `<project>/.opencode/...`?

Потому что это target paths целевого OpenCode-проекта. Source repository хранит
код и поставочные профили, но не обязан загружать сам себя через автопоиск
OpenCode.

### Чем profile отличается от schema?

Profile объединяет настройки, агентов и ссылки на schema. Schema описывает
траекторию workflow и правила переходов. При одном schema в profile можно
выбрать только `profileId`; при нескольких используйте `profileId/schemaId` или
передайте `schemaId` явно.

### Почему стадия есть в YAML, но перейти к ней нельзя?

Наличие стадии не делает переход доступным. Должны выполниться guard, gates,
approval и другие ограничения текущего workflow.

### Можно ли написать собственную schema?

Да. Начните с [schema-writing-guide.md](schema-writing-guide.md), затем проверьте
пример через реальный loader и пользовательский сценарий.

### Почему установленный пакет не видит мой профиль?

Проверьте `SESSION_GUARD_PROFILES_DIR` или положите профиль в
`<project>/.opencode/profiles`. Published package содержит runtime artifacts, но
профили проекта должны быть доступны отдельно loader-у.

### Что делать при отказе в consent?

Исправить план или условия workflow и повторить согласование, если текущая схема
это допускает. В `workflow-consent` укажите тот же `type`, который требует
переход; перечисленные файлы должны оставаться неизменными до принятия решения.
Иначе workflow останется на текущей стадии.

### Как проверить изменения в source repository?

Используйте `mise run check` для typecheck, lint и тестов, `mise run build` для
поставочных артефактов и `mise run smoke` для сценариев с реальным OpenCode-host.
Эти команды не устанавливают плагин автоматически в target project.

### Где искать подробное описание полей?

В [schema-reference.md](schema-reference.md). Готовые варианты находятся в
[schema-examples.md](schema-examples.md).
