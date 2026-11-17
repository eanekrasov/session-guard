# Аудит `as never` и `as unknown`

> **Контекст:** разработка плагина.
>
> **Загружать, когда:** планируется поэтапная работа с TypeScript-приведениями на границах host API, runtime и тестовых fixtures.
>
> **Не использовать для:** утверждений о безопасности каждого приведения без дополнительной проверки его контракта.
>
> **Связанные документы:** [архитектура плагина](./plugin-architecture.md), [правила разработки](../CONTRIBUTING.md).

## Область и метод

Аудит выполнен только чтением текущего checkout. Включены `*.ts`, `*.tsx`, `*.mts` и `*.cts`; исключены `.git`, `.codegraph`, `node_modules` и `dist`. Поиск точной подстроки `\bas\s+(never|unknown)\b` выполнен с учётом скрытых и игнорируемых файлов. Поэтому `as unknown as T` учитывается одним вхождением.

Результат поиска: **205 текстовых совпадений в 64 файлах**. Это 202 строки: пять совпадений находятся в комментариях, ещё два assertions — во временном `.memory`-файле. В рабочем backlog — **198 assertions в 195 строках**. Дополнительный AST-проход распознал 197 assertions с непосредственным типом `never` или `unknown` и три приведения к `never[]`; всего 200 assertions, из которых два во временном файле.

Числа относятся к состоянию checkout на момент аудита и не являются постоянной метрикой. CodeGraph использовался для структурной навигации; индекс не синхронизировался, поэтому мог отставать от локальных изменений. SDK payload и вызовы, которые индекс не разрешил, отмечены как требующие проверки по исходникам и типам SDK. Сложность ниже — оценка планирования, а не рекомендация удалить assertion.

### Обозначения

- **N** — `as never`; **N[]** — `as never[]`; **U** — `as unknown`, в том числе `as unknown as T`.
- **Н / С / В** — низкая / средняя / высокая предварительная сложность.
- `×2` означает два отдельных приведения на одной строке.
- Файлы `*.vitest.ts` и `test-fixtures.ts` классифицированы как тестовые, а не production.

## Production

### V1/V2 hooks и SDK tools

| Файл: строки                                | Приведение и пересекаемый payload                                                  | Оценка                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/rules-engine/runtime/v1-adapter.ts:88` | **N ×2**: `unknown` input/output → callback, выбранный по имени hook               | **В** — общая коллекция стирает связь имени hook и пары параметров; нужна типизированная диспетчеризация. |
| `src/app/v2-plugin-adapter.ts:80`           | **N**: V2 host event после преобразования → аргумент legacy `hooks.event`          | **В** — проверить реальные варианты событий и контракты обеих версий.                                     |
| `src/app/workflow-tool-surface.ts:47`       | **U**: локальное описание tool (`description`, `args`, `execute`) → `SdkToolInput` | **С** — согласовать generic аргументы и сигнатуру SDK, учитывая версию SDK.                               |

### TUI: host API, темы и JSX

| Файл: строки                             | Приведение и пересекаемый payload                                  | Оценка                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/tui/v2.tsx:34`                      | **N**: keymap layer → V2 `keymap.layer`                            | **С** — определить форму слоя и host-контракт.                           |
| `src/tui/v2.tsx:52`                      | **N**: `{ size }` → V2 dialog API                                  | **С** — проверить сигнатуру диалога и версию host.                       |
| `src/tui/v2.tsx:105`                     | **N**: динамический `string` → имя события `ctx.data.on`           | **С** — ограничить допустимые имена и payload событий.                   |
| `src/tui/v2.tsx:166`                     | **U**: host theme → `Record<string, unknown>` для palette          | **С** — проверить поддерживаемые формы темы.                             |
| `src/tui/v1.tsx:734`                     | **U ×2**: theme color и `theme.text` → `string`                    | **С** — сверить реальные значения цветов с host API и JSX.               |
| `src/tui/v1.tsx:753`                     | **U**: V1 theme → `Record<string, unknown>` для palette            | **С** — согласовать palette с поддерживаемой структурой темы.            |
| `src/tui/v1.tsx:800, 822, 824, 844, 864` | **U**, по одному на строку: theme color tokens → `string`          | **С** — одна группа с `:734`, но каждое значение проверить по SDK.       |
| `src/tui/v1.tsx:959, 966, 973, 980, 987` | **U**, по одному на строку: `null` → `JSX.Element`                 | **Н** — выразить nullable-результат, если это допускают вызывающие типы. |
| `src/tui/v1.tsx:1010, 1014`              | **N**, по одному: объекты регистрации TUI → параметры host API     | **С** — сверить формы регистрации с SDK.                                 |
| `src/tui/slots/sidebar-content.tsx:251`  | **U**: результат `theme()` → `Record<string, unknown>` для palette | **С** — граница типизированной темы и обобщённого потребителя.           |
| `src/tui/slots/theme-colors.ts:66`       | **U**: `theme ?? {}` → `TokenMap`                                  | **С** — определить поддерживаемые формы входных токенов.                 |

### Guard AST и JSON boundary

| Файл: строки                                     | Приведение и пересекаемый payload                                            | Оценка                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schema/guard-ast.ts:74`                     | **U**: строка или массив → `Record<string, unknown>` для разрешённого метода | **С** — сохранить allowlist, связь метода и ограничения доступа.                                                                                                            |
| `src/schema/guard-ast.ts:78`                     | **U**: массив → `Record<string, unknown>` для цифрового ключа                | **Н** — возможно индексировать массив напрямую, сохранив проверку ключа.                                                                                                    |
| `src/schema/guard-ast.ts:518`                    | **U**: `undefined` → `null` в literal AST                                    | **С** — проверить модель литерала и семантику evaluator/compiler.                                                                                                           |
| `packages/dashboard/src/session-guard-cli.ts:23` | **U**: результат `JSON.parse(stdout)` → `unknown`                            | **Н** — может намеренно ограничивать `any`, а не скрывать несовместимость. Файл входил в перенос dashboard и удалён в задаче 3.4 (вся работа через Next.js route handlers). |

## Tests и fixtures

### V2 context, hooks, events и synthetic messages

| Файл: строки                                                                         | Приведение и пересекаемый payload                                      | Оценка                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `test/app/v2-plugin-adapter.test.ts:70, 162, 217, 378, 430, 473, 520, 541, 566, 589` | **U**, по одному: частичные mock-объекты → V2 `Context`                | **С** — общий fixture может снять повторы, но надо сохранить различия сценариев. |
| `test/app/v2-plugin-adapter.test.ts:81`                                              | **U**: mock V2 context → локальная изменяемая форма                    | **С** — проверить поля, которые тест подменяет.                                  |
| `test/app/v2-plugin-adapter.test.ts:90`                                              | **U**: локальная форма → V2 `Context`                                  | **С** — связана с предыдущей строкой и полнотой mock.                            |
| `test/app/v2-plugin-adapter.test.ts:259`                                             | **N**: тестовый event → callback context hook                          | **С** — восстановить связь hook и payload.                                       |
| `test/app/v2-plugin-adapter.test.ts:318, 319, 323`                                   | **N**, по одному: host messages и legacy messages → проверяемые типы   | **С** — согласовать две формы сообщений и synthetic injection.                   |
| `test/app/v2-plugin-adapter.test.ts:891, 947`                                        | **U**, по одному: mock context → локальная форма `session.context`     | **С** — тестам нужен доступ к подменяемой части API.                             |
| `test/app/v2-plugin-adapter.test.ts:900, 951`                                        | **U**, по одному: локальный mock → полный V2 `Context`                 | **С** — связаны с предыдущими строками.                                          |
| `test/app/v2-stage-instructions.test.ts:45, 111`                                     | **N**, по одному: частичный V2 context → параметр инициализации        | **С** — типизировать fixture с сохранением различий сценариев.                   |
| `test/app/v2-stage-instructions.test.ts:62, 120`                                     | **N**, по одному: event → сохранённый context hook                     | **С** — уточнить event payload и callback.                                       |
| `test/app/v2-profile-agent-sync.test.ts:53`                                          | **U**: частичный mock → `Context`                                      | **С** — неполная host API поверхность.                                           |
| `test/app/v2-command-adapter.test.ts:47, 63, 209, 230, 263, 298`                     | **U**, по одному: mock-объекты → `Context`                             | **С** — общая группа неполных контекстов, сценарии различаются.                  |
| `test/app/v2-command-adapter.test.ts:60`                                             | **U**: `undefined` → `Promise<never>` в mock `transform`               | **С** — проверить async-сигнатуру и возвращаемое значение.                       |
| `test/app/v2-command-adapter.test.ts:190`                                            | **U**: запись агента `{ id, name, mode }` → `Record<string, …>`        | **Н** — локальная форма тестовых данных.                                         |
| `test/app/plugin-v2-contract.test.ts:129`                                            | **N ×2**: `{ parentID: 'root' }` и `{}` → варианты ответа mock session | **С** — привести mock к контракту ответа или минимальному порту.                 |
| `test/app/plugin-v2-contract.test.ts:131`                                            | **N**: частичный объект клиента → host-контракт                        | **С** — связано с mock-ответами на `:129`.                                       |
| `src/rules-engine/test-fixtures.ts:209, 211, 219, 221`                               | **N**, по одному: V2 tool/session handlers → массивы recorders         | **С** — регистрация теряет связь discriminant имени и типа handler.              |
| `src/rules-engine/test-fixtures.ts:280`                                              | **N**: mock context → `runtime.wire`                                   | **С** — проверить полноту и перегрузки mock hook API.                            |
| `src/rules-engine/session/file-observation-lsp.integration.vitest.ts:59, 112`        | **N**, по одному: `mockInput.context` → `runtime.wire`                 | **С** — общая проблема shared fixture.                                           |
| `src/rules-engine/runtime/chat-message-persistence.vitest.ts:65`                     | **N**: `mockInput.context` → `runtime.wire`                            | **С** — общая проблема shared fixture.                                           |
| `src/rules-engine/runtime/chat-message-persistence.vitest.ts:124`                    | **N**: test object → параметр runtime                                  | **С** — уточнить форму сообщения/event в сценарии.                               |
| `src/rules-engine/runtime/chat-message-persistence.vitest.ts:760`                    | **N**: mock `sessionApi` → свойство session context                    | **С** — сверить полную сигнатуру session API.                                    |
| `src/rules-engine/runtime/orchestration.vitest.ts:48`                                | **N**: `mockInput.context` → `runtime.wire`                            | **С** — общая проблема shared fixture.                                           |
| `src/rules-engine/runtime/tool-ids.vitest.ts:50, 71`                                 | **N**, по одному: test tool payload → ожидаемые параметры              | **С** — согласовать обязательные поля hook payload.                              |
| `src/rules-engine/session/session-working-context.vitest.ts:25, 56, 201`             | **N[]**, по одному: массивы parts → message parts                      | **С** — типизировать части сообщений, сохраняя разнообразие сценариев.           |
| `src/rules-engine/session/session-working-context.vitest.ts:187, 189`                | **U**, по одному: `{ info: undefined }` и `null` → `MessageWithInfo`   | **Н** — намеренно некорректные данные для проверки границы.                      |
| `src/rules-engine/delivery/rule-delivery-admission.vitest.ts:161`                    | **N**: test messages → ожидаемая форма сообщений                       | **С** — проверить различия message/part payload.                                 |
| `src/rules-engine/delivery/rule-delivery.vitest.ts:1106`                             | **U**: `null` → `{ info; parts }`                                      | **Н** — негативный вход; assertion может быть намеренным.                        |
| `src/rules-engine/delivery/rule-delivery-codec.vitest.ts:115`                        | **N**: `null` в массиве → codec element                                | **Н** — негативный тест обработки ошибки.                                        |

### V1 hooks, plugin input и host-клиенты

| Файл: строки                                            | Приведение и пересекаемый payload                                                               | Оценка                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `test/app/plugin.test.ts:58, 71, 83, 96, 107`           | **N**, по одному: mock `ctx` → V1 plugin input                                                  | **С** — общий fixture при сохранении сценариев.                                                         |
| `test/app/project-isolation.test.ts:81, 82`             | **N**, по одному: `makeCtx(...)` → V1 plugin input для двух проектов                            | **С** — типизировать fixture, не потеряв изоляцию проектов.                                             |
| `test/app/v1-rules-adapter.test.ts:16`                  | **U**: context → локальная форма V2-интерфейса                                                  | **С** — уточнить используемую поверхность API.                                                          |
| `test/app/v1-rules-adapter.test.ts:48`                  | **N**: mock runtime → `wireV1Rules`                                                             | **С** — минимальный runtime port или полноценный mock.                                                  |
| `test/app/runtime.test.ts:48, 583, 649, 699`            | **U**, по одному: частичный client, в том числе `app.log` → `PluginInput['client']`             | **С** — общий client fixture либо узкий порт; не расширять production API только ради теста без оценки. |
| `test/app/runtime.test.ts:819`                          | **N**: test config → V1 config hook                                                             | **С** — проверить обязательные поля конфигурации.                                                       |
| `test/app/runtime.test.ts:1398`                         | **N**: test output → hook output                                                                | **С** — проверить конкретную форму output.                                                              |
| `test/app/session-executor-persistence.test.ts:59`      | **U**: частичный client → `PluginInput['client']`                                               | **С** — общий host-client fixture.                                                                      |
| `test/app/auto-start.test.ts:48`                        | **U**: частичный объект → `PluginInput`                                                         | **С** — проверить реально используемые поля входа.                                                      |
| `test/app/error-funnel.test.ts:36`                      | **U**: mock client → `PluginInput['client']`                                                    | **С** — определить используемую поверхность клиента.                                                    |
| `test/app/create-workflow-schema-id.test.ts:34`         | **U**: client с `app.log` → `PluginInput['client']`                                             | **С** — общий host-client fixture.                                                                      |
| `test/e2e/live-workflow-create.test.ts:26, 33, 36, 38`  | **N**, по одному: частичные `client`, environment, `experimental_workspace`, `$` → plugin input | **С** — реалистичный input fixture без изменения смысла e2e.                                            |
| `test/app/runtime-host-adapter.test.ts:32, 72, 90, 108` | **N**, по одному: частичные host payload/объекты → adapter contracts                            | **С** — уточнить обязательные поля каждого сценария.                                                    |
| `test/app/stage-instructions-context.test.ts:48`        | **N**: `{ sessionID: 'root', model: {} }` → hook input                                          | **С** — проверить обязательные model fields и host payload.                                             |

### Tools, workflow, consent и runtime ports

| Файл: строки                                                                                                | Приведение и пересекаемый payload                                      | Оценка                                                                |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `test/app/v2-tool-surface-adapter.test.ts:41`                                                               | **U**: partial mock → `MutationOrchestrator`                           | **С** — класс/порт шире потребности теста.                            |
| `test/app/v2-tool-surface-adapter.test.ts:53`                                                               | **U**: partial mock → `TaskApi`                                        | **С** — аналогичная граница partial API.                              |
| `test/app/v2-tool-surface-adapter.test.ts:71`                                                               | **U**: registered tool → локальный `CapturedTool`                      | **С** — сверить SDK tool с capture type.                              |
| `test/app/workflow-tool-surface.test.ts:21`                                                                 | **U**: partial mock → `SessionExecutor`                                | **С** — выделить используемую поверхность fixture.                    |
| `test/app/workflow-tool-surface.test.ts:34`                                                                 | **U**: partial mock → `TaskApi`                                        | **С** — общая проблема mock ports.                                    |
| `test/app/workflow-tool-surface.test.ts:104`                                                                | **N**: test object → tool parameter                                    | **С** — проверить обязательные поля конкретного вызова.               |
| `test/app/workflow-lifecycle.test.ts:27`                                                                    | **N**: `vi.fn()` → `executor.run`                                      | **Н** — задать совместимую сигнатуру mock-функции.                    |
| `test/app/workflow-lifecycle.test.ts:35, 72, 81, 128`                                                       | **N**, по одному: mocks/results → lifecycle dependencies               | **С** — проверить сигнатуры и результаты вызовов.                     |
| `test/app/workflow-lifecycle.test.ts:133`                                                                   | **N**: partial async engine с `isTerminalStage` → resolver             | **С** — проверить partial engine implementation.                      |
| `test/app/session-executor-persistence.test.ts:118`                                                         | **U**: partial store → `WorkflowStore`                                 | **С** — согласовать используемые методы store.                        |
| `test/app/session-executor-persistence.test.ts:354`                                                         | **U**: `s` → `Promise<void>`                                           | **С** — сначала выяснить тип и смысл ожидаемого результата.           |
| `test/app/session-executor.test.ts:34`                                                                      | **U**: partial store → `WorkflowStore`                                 | **С** — общая проблема mock store.                                    |
| `test/app/consent-orchestrator.test.ts:87, 107, 137, 165, 220, 248, 285, 321, 355, 398, 432, 468, 580, 661` | **U**, по одному: test `manifest` → `ConsentManifest` для `evidenceOf` | **С** — общее семейство fixtures; проверить различия и negative data. |
| `test/app/consent-roundtrip.test.ts:33`                                                                     | **U**: partial client → `SessionClient`                                | **С** — согласовать методы mock session client.                       |
| `test/app/consent-roundtrip.test.ts:38`                                                                     | **U**: `{ session: client() }` → `PluginInput['client']`               | **С** — общий host-client fixture.                                    |
| `test/app/consent-roundtrip.test.ts:71`                                                                     | **N**: `{ files, summary }` → tool arguments                           | **С** — проверить SDK argument shape.                                 |
| `test/app/consent-roundtrip.test.ts:72, 85, 94, 106`                                                        | **N**, по одному: `{ sessionID }` → tool context                       | **С** — типизированный context с обязательными SDK полями.            |
| `test/app/consent-roundtrip.test.ts:81`                                                                     | **N**: test object/result → ожидаемый call type                        | **С** — сверить контракт roundtrip.                                   |
| `test/app/create-workflow-schema-id.test.ts:49, 59`                                                         | **N**, по одному: schema/tool payload и context → параметры вызова     | **С** — проверить schema arguments и обязательные поля context.       |
| `test/app/parallel-verifiers.test.ts:355`                                                                   | **N**: partial object → verifier scenario parameter                    | **С** — уточнить тестируемый контракт.                                |
| `test/app/tool-execution-policy.test.ts:22`                                                                 | **N**: `{}` → session в task input                                     | **С** — нужен корректный минимальный session fixture.                 |

### Schema, session, guards и намеренно некорректные входы

| Файл: строки                                                 | Приведение и пересекаемый payload                                         | Оценка                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `test/session/session-store.test.ts:172`                     | **U**: loaded session → `Record<string, unknown>` для будущего поля       | **Н** — проверка сохранения неизвестного поля; вероятно намеренная dynamic boundary. |
| `test/session/session-store.test.ts:271`                     | **U**: test object → `Record<string, unknown>`                            | **Н** — проверить необходимость cast для динамического поля.                         |
| `test/session/session-schema.test.ts:305`                    | **U**: session object → `Record<string, unknown>`                         | **Н** — тест неизвестных/динамических полей схемы.                                   |
| `test/schema/guard-facts-exist.test.ts:113`                  | **U**: `toGuardContext` → `Record<string, unknown>`                       | **С** — согласовать guard context и dynamic evaluator.                               |
| `test/schema/compile-validation.test.ts:265`                 | **N**: partial stage `{ agents: ['code'] }` → stage type                  | **Н** — проверить, является ли неполнота намеренным negative case.                   |
| `test/domain/engine.test.ts:185`                             | **N**: `{ stageOverride: 'COMMIT' }` → `makeSession` input                | **С** — проверить допустимость override в fixture.                                   |
| `test/domain/validate-transition.test.ts:30, 41, 78, 127`    | **U**, по одному: partial session facts → `SessionFacts`                  | **С** — defaults в typed fixture либо сохранить partial negative data.               |
| `test/app/runtime-boundary-regressions.test.ts:177`          | **U**: `toGuardContext(session)` → `Record<string, unknown>`              | **С** — общая граница guard context.                                                 |
| `test/app/runtime-boundary-regressions.test.ts:223`          | **U**: `{ task }` → evaluator `Record<string, unknown>`                   | **Н** — проверить необходимость промежуточного `unknown`.                            |
| `test/app/guardrails.test.ts:33`                             | **U**: test input → `string` для `validateUserInput`                      | **Н** — вероятный negative case для runtime boundary; сохранить сценарий.            |
| `test/app/trace.test.ts:41, 42, 45`                          | **U**, по одному: `null`, `null`, `undefined` → `Record<string, unknown>` | **Н** — намеренная проверка устойчивости к неправильным значениям.                   |
| `src/rules-engine/config/plugin-options.vitest.ts:86`        | **U**: `null` → `Readonly<Record<string, unknown>>`                       | **Н** — negative test границы конфигурации.                                          |
| `src/rules-engine/rules/rule-filter.vitest.ts:296`           | **N**: metadata fixture → `hasFileObservationFamily`                      | **Н** — проверить, намеренно ли metadata неполная.                                   |
| `src/rules-engine/session/matched-rules-state.vitest.ts:278` | **U**: store → локальная форма с `writeQueues`                            | **С** — test обращается к внутреннему состоянию; возможно изменить стратегию теста.  |

### TUI tests, smoke и прочие mocks

| Файл: строки                                                                                    | Приведение и пересекаемый payload                      | Оценка                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `test/tui/slots/sidebar-mount.test.tsx:50`                                                      | **N**: test theme → component prop                     | **С** — согласовать fixture с поддерживаемой темой.                              |
| `test/tui/tui.integration.test.ts:50`                                                           | **N**: пустая строка → mock `DialogAlert` result       | **Н** — проверить допустимый JSX result mock.                                    |
| `test/tui/tui.integration.test.ts:70`                                                           | **N**: partial renderer → host renderer                | **С** — mock реализует лишь используемый метод.                                  |
| `test/tui/tui.integration.test.ts:147`                                                          | **U**: mock → `SessionGuardTuiV2` parameter            | **С** — нужен совместимый TUI context fixture.                                   |
| `test/tui/tui.integration.test.ts:217`                                                          | **N**: пустая строка → mock result                     | **Н** — проверить допустимый return type.                                        |
| `test/tui/tui.integration.test.ts:246`                                                          | **U**: captured object → `{ namespace?; title?; run }` | **С** — уточнить registration type и capture.                                    |
| `smoke/test/harness.test.ts:192`                                                                | **N**: `{ homeDir }` → smoke harness parameters        | **С** — проверить реально нужные поля сценария ошибки.                           |
| `smoke/test/host-types.test.ts:33`                                                              | **N**: `{ status: 'blocked' }` → invariant input       | **Н** — вероятно намеренная некорректная комбинация.                             |
| `smoke/test/v2-client.test.ts:8, 10, 17`                                                        | **N**, по одному: test option/field objects → V2 forms | **С** — типизировать общие фабрики по SDK contract.                              |
| `smoke/test/v2-client.test.ts:99`                                                               | **N**: partial test object → V2 client payload         | **С** — сверить форму ответа.                                                    |
| `test/helpers.ts:31`                                                                            | **N**: общий test object → helper parameter            | **С** — определить пользователей helper перед изменением fixture.                |
| `src/rules-engine/detection/git-branch.vitest.ts:17, 30, 39, 50, 61, 71, 81, 91, 101, 111, 120` | **U**, по одному: mock `execFile` → `typeof execFile`  | **С** — Node API перегружен; фабрика должна сохранить callback и error варианты. |

## Не assertions и временные данные

Пять совпадений не являются assertions и не включены в backlog:

| Файл: строки                             | Причина                                      |
| ---------------------------------------- | -------------------------------------------- |
| `test/app/bridge.test.ts:34, 41, 44, 46` | Четыре `as never` в закомментированном коде. |
| `smoke/src/host/transport.ts:489`        | `as unknown` находится в комментарии.        |

Во временном файле `.memory/commit-split/adapter.test.final.ts:40, 52` находятся два **U** к `MutationOrchestrator` и `TaskApi`. Они входят в статистику поиска, но исключены из рабочего backlog.

## Незакоммиченная работа

На момент аудита:

- `src/app/v2-plugin-adapter.ts` изменён; occurrence на строке 80 относится к текущему рабочему файлу.
- `packages/dashboard/src/session-guard-cli.ts` добавлен в индекс в рамках пользовательского переноса dashboard; occurrence на строке 23 относится к этой работе. Файл удалён в задаче 3.4 — дашборд переведён на Next.js route handlers, работающие через единый CLI-мост `src/server/core.ts`.
- `packages/dashboard/README.md` untracked, но не входит в выбранные расширения.
- Старые пути dashboard в `src/dashboard` отмечены удалёнными; отсутствующие файлы не инвентаризировались по исторической версии Git.
- Остальные незакоммиченные изменения не следует перезаписывать или считать частью завершённой миграции на основании этого отчёта.

## Групповые причины и порядок работ

1. **Потеря связи hook-name ↔ payload.** Сначала сверить реальные V1/V2 hook inputs и outputs, затем типизировать диспетчеризацию и преобразователи; после — обновлять связанные fixtures. Это самая рискованная группа.
2. **Host/SDK контракты шире частичных тестовых mocks.** Проверить SDK сигнатуры, затем уточнить tool/context boundaries и объединять только действительно одинаковые fixtures. Не расширять production API исключительно ради тестов без отдельного обоснования.
3. **TUI использует несколько разных host API границ.** Отдельно исследовать цвета, palette, keymap, dialog, event names и JSX-nullability; не объединять механически.
4. **Guard evaluator и AST работают с динамическими данными.** Сохранять allowlist и семантику отсутствующих свойств; literal `undefined` анализировать отдельно от индексирования массивов.
5. **Negative tests и `unknown` boundaries не являются автоматическим долгом.** Assertions, создающие заведомо недопустимый вход, могут быть оправданы. `JSON.parse(...) as unknown` может намеренно удерживать результат в безопасном типе.

## Ограничения

Сложность и группировка помогают планировать, но не доказывают, что конкретный cast небезопасен или должен быть удалён. Часть тестовых строк описана на уровне сценария; перед изменениями нужно проверить конкретные сигнатуры и цепочки вызовов. Runtime и тесты в рамках аудита не запускались.
