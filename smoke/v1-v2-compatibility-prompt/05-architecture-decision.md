# Архитектурное решение и порядок выполнения

Эта задача является не только изменением smoke-тестов. Она включает проверку
границы между production plugin contract и OpenCode V1/V2 transport contract.

## Можно ли выполнить plugin refactor отдельно от smoke adapters

Частично — да, но не полностью.

### Что можно сделать независимо

Production plugin можно сначала привести к общему внутреннему контракту, если
изменение касается собственных semantics plugin:

- общего result shape инструментов;
- единой модели session/task/consent facts;
- общей нормализации agent/session context;
- единого слоя host capability access;
- устранения дублирования V1/V2 в plugin runtime.

Такой refactor можно проверить plugin unit/integration tests и сборкой, не запуская
сразу весь smoke suite.

### Что нельзя надёжно доказать отдельно

Plugin refactor в отрыве от smoke adapters не доказывает, что:

- V1 и V2 действительно доставляют одинаковые inputs;
- V1/V2 forms/questions одинаково отвечаются;
- agent selection имеет одинаковый эффект;
- plugin загружается одинаково;
- timeout, wait и cleanup semantics сопоставимы;
- живой host вызывает один и тот же workflow path.

Поэтому plugin refactor может быть отдельным подготовительным этапом, но его
приёмка должна завершаться интеграционной проверкой через оба transport пути.

## Рекомендуемый порядок

1. Read-only map production plugin и smoke-suite.
2. Parity matrix всех текущих сценариев.
3. Классификация несовпадений: transport, orchestration, plugin contract или domain behavior.
4. Минимальный plugin refactor, если он действительно нужен.
5. Plugin unit/integration tests, `mise run check`, `mise run build`.
6. Единый `SmokeHost` facade и две внутренние transport strategies.
7. Один canonical scenario registry и один runner.
8. Нормализованные forms, messages, tool results и timeout status.
9. Безопасная retry policy.
10. Запуск одинакового scenario set через V1 и V2.
11. Structural parity report и behavioral parity report.
12. Live smoke для обоих host kinds.

## Вертикальный срез первого этапа

Первый change должен быть небольшим и проверяемым:

1. сохранить текущую V1/V2 suite как baseline;
2. добавить единый `SmokeHost` facade;
3. добавить две внутренние transport strategies;
4. добавить один общий runner;
5. создать один canonical registry;
6. перевести `plugin-loads` и `create`;
7. запустить оба сценария (`plugin-loads` и `create`) live через V1 и V2;
8. при недоступной среде записать `not-run` с причиной
   `live-environment-unavailable` и вернуть exit code `5`;
9. сравнить structural и behavioral parity.

Не включай в этот change полную миграцию consent, task, negative, commit,
subagent, CI/CD или глобальную замену retry semantics. Следующие изменения можно
выполнять отдельными последовательными этапами после успешного среза.

## Переходная реализация

Предпочтительный способ реализации — staged migration поверх текущего кода:

- текущие V1/V2 runner-ы и тесты остаются baseline;
- новый `SmokeHost` facade и общий runner создаются рядом;
- transport helpers переиспользуются через thin wrappers, а не копируются;
- сначала мигрируется один простой сценарий (`create` или `plugin-loads`);
- затем мигрируются consent, task, negative и commit-сценарии;
- после каждой миграции сравниваются V1/V2 результаты с parity matrix;
- после миграции всех сценариев старые runner-ы и независимые registry удаляются.

Не считай задачу завершённой, если новая и старая реализации обе остаются
постоянными источниками истины. Compatibility bridge — временный механизм миграции,
а не итоговая архитектура.

Полезная целевая структура:

```text
smoke/src/host/types.ts
smoke/src/host/transport.ts
smoke/src/host/facade.ts
smoke/src/runner.ts
smoke/src/scenarios/*.ts
```

Конкретные имена не обязательны, но границы должны отделять общий сценарный API
от V1/V2 transport details.

## Правило приёмки

Нельзя считать общий plugin API успешным только по plugin unit-тестам. Нельзя
считать общий smoke facade успешным только по unit-тестам адаптера. Финальная
приёмка должна содержать:

- plugin checks, если plugin менялся;
- smoke unit-тесты;
- одинаковые сценарии через V1 и V2;
- явные PASS/FAIL/BLOCKED результаты;
- объяснение каждого расхождения.

## Граница между слоями

Оставь в plugin:

- domain semantics workflow;
- общие plugin result types;
- внутреннюю нормализацию host context, если она нужна нескольким runtime paths;
- публичный plugin behavior.

Оставь в `SmokeHost` facade:

- V1 HTTP endpoint details;
- V2 generated client details;
- V1/V2 auth;
- plugin config syntax;
- forms versus questions;
- agent selection mechanism;
- startup and cleanup differences.

Не дублируй одну и ту же domain logic в plugin и smoke facade.

## Решение по типам

Smoke не импортирует типы из production plugin. Это намеренная граница, потому что
smoke должен проверять собранный plugin как внешний потребитель через реальный
OpenCode host, а не подтверждать compile-time совместимость с внутренними файлами.

Локальные smoke-типы допустимы и предпочтительны для:

- V1/V2 transport normalization;
- normalized messages, tools и forms;
- observable workflow state;
- scenario results и parity reports.

Если plugin contract рефакторится, production plugin получает свои типы и тесты,
а smoke получает независимое описание наблюдаемого внешнего контракта. Эти две
модели могут быть семантически согласованы, но не должны быть связаны импортом
внутренних модулей.

Исключение — отдельный стабильный public contract package, согласованный как
самостоятельное архитектурное решение. Его создание не входит в текущую задачу;
не вводи такой package молча ради сокращения кода.
