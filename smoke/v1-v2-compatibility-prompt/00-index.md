# Промпт: паритет smoke-сценариев V1/V2

Прочитай все части в указанном порядке. Это один промпт, разделённый на файлы
только для управляемого размера контекста. Не выполняй задачу по одной части и не
делай промежуточных выводов: сначала прочитай все файлы.

Репозиторий:
`/Users/e.nekrasov/Projects/harness/session-guard`

Цель: провести контролируемый рефакторинг контракта интеграции и smoke-сценариев,
чтобы ровно OpenCode V1 и V2 работали через один общий `SmokeHost` interface и
один общий scenario runner. Внутри фасада допускаются две transport strategies,
но сценарии, assertions, operator policy и runner должны быть общими.

Порядок чтения:

1. `01-scope-and-context.md` — границы и контекст;
2. `02-unified-host-contract.md` — единый интерфейс и фасад;
3. `03-parity-and-safe-retries.md` — retry и mutating steps;
4. `04-tests-docs-and-delivery.md` — unit-тесты и первый vertical slice;
5. `05-architecture-decision.md` — граница plugin refactor и smoke adapters;
6. `06-scenario-contract-and-registry.md` — scenario metadata и canonical registry;
7. `07-assertions-results-and-parity.md` — assertions, blocked, results и parity;
8. `08-documentation-and-delivery.md` — README, проверки и итоговый отчёт.

Все требования из частей обязательны и образуют одну задачу. Это не только
написание smoke-промпта: сначала нужно определить границу между smoke facade и
production plugin contract, затем выполнить минимальный необходимый рефакторинг.
Поддержка V3,
неизвестных и будущих версий OpenCode не входит в задачу.

Перед реализацией составь parity matrix по всем текущим сценариям. Не объявляй
задачу выполненной только потому, что общий интерфейс компилируется или unit-тесты
проходят: нужен отдельный structural parity и behavioral parity вывод для V1/V2.

Реализуй задачу как поэтапную миграцию, а не как переписывание текущей suite
«на месте». Сохрани текущую V1/V2 реализацию как baseline, добавь новый общий слой
рядом, переводи сценарии по одному и удаляй legacy-код только после подтверждённой
миграции всех сценариев.

Начни с обязательного вертикального среза: общий `SmokeHost` facade, две внутренние
transport strategies, один runner, один canonical registry и сценарии `plugin-loads`
и `create`, запускаемые одинаково через V1 и V2. `no-session` в первый этап не
входит и переносится на следующий этап вместе с остальными сценариями. Только
после успешного среза переходи к `no-session`, consent, task, negative, commit,
subagent и pipeline-сценариям.

На первом этапе canonical registry всё равно создаётся для всех текущих V1 IDs.
Реально runnable и проверяемыми через оба host kinds становятся только `plugin-loads`
и `create`; остальные сценарии получают `not-run` в parity report и не считаются
мигрированными, `blocked` или behavioral parity. Финальная задача закрывается только
после отдельной миграции заявленного полного набора без `not-run`.

Для каждого этапа authoritative является новый общий runner для мигрированных
сценариев. Старые runner-ы запускаются только как baseline comparison и не формируют
итоговый parity report. Compatibility bridge удаляется после миграции последнего
сценария.

Если для корректного общего контракта нужен production plugin change, разрешается
изменять `src/`, но только по правилам границы plugin/smoke из части
`01-scope-and-context.md` и с обязательными plugin checks из части
`04-tests-docs-and-delivery.md`.
