# host-smoke — плагин против настоящего opencode

```bash
mise run smoke                          # паритет: canonical-сценарии через V1 и V2
mise run smoke plugin-loads create      # только эти сценарии, оба host kind
HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke create    # проверка одного хоста
HOST_SMOKE_BASELINE=1 mise run smoke plugin-loads       # baseline: старый runner
bun test smoke/                         # тесты самой suite
```

Ни один сценарий не обращается к плагину напрямую. Каждый поднимает настоящий
`opencode serve` во временном проекте и проверяет то, что хост и плагин **фактически**
сделали: сохранённую плагином workflow-сессию и tool-результаты, записанные хостом.

## Раскладка

`smoke/` — самостоятельный проект. Границы такие:

| Файл                                                                | Ответственность                                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/host/types.ts`                                                 | локальные normalized smoke-типы: сессия, ход, tool call, durable state, plugin evidence, scenario result, parity entry |
| `src/host/transport.ts`                                             | внутренний seam `HostTransport` и нормализация payload-ов хоста в общие типы                                           |
| `src/host/v1-transport.ts`                                          | transport strategy V1: Legacy HTTP API                                                                                 |
| `src/host/v2-transport.ts`                                          | transport strategy V2: `@opencode/client`                                                                              |
| `src/host/facade.ts`                                                | контракт `SmokeHost`, выбор strategy, старт изолированного хоста                                                       |
| `src/registry.ts`                                                   | один canonical registry сценариев                                                                                      |
| `src/runner.ts`                                                     | один общий runner: шаги, retry, assertions, cleanup, результат                                                         |
| `src/parity.ts`                                                     | сравнение V1/V2 и единый aggregate exit code                                                                           |
| `src/report.ts`                                                     | отчёт прогона (одна схема для V1 и V2)                                                                                 |
| `src/scenarios/*.ts`                                                | сценарии, определения профилей-фикстур в `profile/`                                                                    |
| `src/scenario-kit.ts`, `src/v2-scenario-kit.ts`, `src/v2-client.ts` | устаревший runner и его transport; остаётся baseline до конца миграции                                                 |

Рядом лежит `test/` — тесты suite; в `test/` плагина остаются только его собственные
тесты. Только корневой `src/` собирается в `dist/`; этот запускается bun'ом напрямую.

Две вещи намеренно читаются из корня репозитория: `profiles/base` (каждый профиль —
дельта к поставляемой базе) и `scripts/commit-task.ts` (копируется во временный
проект как точка коммита). Ничего здесь не импортирует `src/` плагина.

## Один фасад, два внутренних транспорта

Сценарии и runner зависят только от `SmokeHost`:

```ts
interface SmokeHost {
  readonly kind: 'v1' | 'v2';
  createSession(title: string): Promise<SmokeSession>;
  runPrompt(session: SmokeSession, input: PromptInput): Promise<PromptResult>;
  readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>;
  closeSession(session: SmokeSession): Promise<void>;
}
```

Внутри фасада ровно один раз выбирается strategy: `LegacyHttpTransport` (V1) или
`SessionClientTransport` (V2). Сценарии и runner не знают endpoint-ы, generated client,
Basic Auth, `question` против форм, передачу агента и различия старта сессии — всё это
остаётся в strategy. Ветвление по версии в общем коде запрещено.

Обе strategy приводят ответ хоста к одним и тем же типам:

- `NormalizedTurn` — `status` (`completed` / `timed-out` / `failed` / `unknown`),
  транскрипт, parts и tool calls;
- `NormalizedToolCall` — имя, статус, вывод, ошибка; имя всегда плагинного tool-а,
  даже если хост исполнял его через собственную обёртку, поэтому из tool calls читается
  plugin evidence одинаково на обоих host kinds;
- `SmokeWorkflowState` — durable состояние плагина, прочитанное через хост;
- `PluginObservation` — `loaded`, `observedPluginTools`, `invokedTools`, `hostOperation`,
  `result`. Имена отражают ровно то, что наблюдалось в живом выполнении: полного списка
  зарегистрированных инструментов не отдаёт ни один хост (V2 `plugin.list` сообщает только
  `{id, source, features, state}`, у V1 каталога инструментов нет), поэтому evidence не
  заявляет о registry, которого не читал.
- `hostOperation` — не вывод из tool calls, а **утверждение слоя, который вёл живой хост**:
  его передаёт транспорту его strategy (`buildPromptResult(..., 'real-host')`), чистый builder
  сам ничего не утверждает (`'unknown'`), а фасад проверяет инвариант в рантайме — стратегия,
  которая не подтвердила работу с живым хостом, отклоняется, а не отдаётся сценарию как
  доверенное evidence. Синтетическое наблюдение runner-а (ход не вернулся, судим по durable
  state) честно помечено `'unknown'`, а `plugin-loads` проверяет маркер явно.

`pluginEvidence` обязателен в `PromptResult`, поэтому сценарий `plugin-loads` не может
пройти только потому, что промпт завершился без ошибки: нужен вызов tool-а плагина
(`workflow-*`) со структурированным результатом.

`SmokeWorkflowState` — локальный тип. Состояние, которое сохранил плагин, читается как
`unknown` и сужается вручную: type assertion не проверяет JSON во время выполнения.
Чтение различает три состояния, и они не смешиваются:

| Что вернуло чтение | Смысл                                                                                         | Для mutating-шага                                               |
| ------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `null`             | в store действительно нет сессии                                                              | доказанное отсутствие мутации (`durableMutation=none`) → `fail` |
| state              | сессия прочитана и сужена                                                                     | `durableMutation=applied`                                       |
| reject             | store есть, но его нельзя подтвердить: не читается, либо payload не является сессией workflow | `durableMutation=unknown` → `blocked`/`indeterminate_mutation`  |

Поэтому повреждённый или чужой payload никогда не принимается за доказанное отсутствие
мутации, а `null` означает ровно одно: ничего не сохранено.

## Общий контракт сценария и результат

Один canonical registry (все 11 текущих id) обслуживает оба host kind: runner выбирает
хост, а не список сценариев. Сценарий объявляет шаги:

```ts
interface ScenarioStep {
  instruction: string;
  mutation: 'read-only' | 'mutating';
  retry: 'same-session' | 'new-session' | 'poll-state' | 'none';
  expect: (result: PromptResult) => true | string;
}
```

`expect` возвращает `true` или причину: текст попадает в evidence шага, а не в вердикт
модели. Предпочтение отдаётся durable state, нормализованным tool calls и
структурированному результату; regex по тексту модели — только там, где нет
структурированного сигнала.

Результат сценария строго один из трёх:

| Статус    | Что означает                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `pass`    | каждый шаг выполнил своё ожидание на наблюдаемом свидетельстве                                                      |
| `fail`    | непройденное ожидание, инфраструктурное исключение или ошибка плагина                                               |
| `blocked` | подтверждённое ограничение контракта V1/V2, недоступная обязательная возможность или недоказуемый результат мутации |

`blocked` создаёт только runner или facade, и только с `blockedReason` из закрытого
набора (`adapter_contract_mismatch`, `required_host_capability_unavailable`,
`indeterminate_mutation`) и с evidence, где названы operation, host kind, шаг и
наблюдаемое ограничение.

`not-run` — **не** статус результата сценария. Он живёт только в
`ParityReportEntry.parity` и всегда имеет причину:

- `pending-migration` — сценарий ещё не мигрирован (aggregate exit code `4`);
- `live-environment-unavailable` — migrated обязательный сценарий не удалось запустить
  до его начала: нет бинарника хоста, модель не разрешается, хост не поднялся
  (aggregate exit code `5`).

`not-run` ставится только для сценария, который не запускался: из-за `pending-migration` или
недоступной живой среды. Ошибка bootstrap, вызванная сломанным
harness или плагином (не читается конфигурация, нет фикстуры профиля, не собрался
плагин), остаётся фатальной и завершает прогон кодом `2` — в фасаде это одно место,
`classifyBootstrapError`, и никакое исключение запуска не превращается в «среду нет»
целиком. Ошибка внутри уже поднятого хоста (транспорт, tool, assertion) — это `fail`
сценария, а не `blocked` и не `not-run`.

Aggregate exit code один для обоих host kind:

| Код | Условие                                                                                     |
| --- | ------------------------------------------------------------------------------------------- |
| `0` | все обязательные runnable-сценарии прошли и незавершённого нет                              |
| `1` | есть `fail`                                                                                 |
| `2` | ни один сценарий не запустился и причина не названа, либо фатальная ошибка адаптера/запуска |
| `3` | есть `blocked` и нет `fail`                                                                 |
| `4` | осталась только незавершённая миграция                                                      |
| `5` | живая среда недоступна для migrated-сценария                                                |

Приоритет: `fail`/fatal, затем `blocked`, затем недоступная среда, затем
незавершённая миграция. Причина `not-run` читается **до** вывода «ничего не
запускалось»: выбор из одних `pending-migration` — это `4`, а хост, который не поднялся,
— `5`; ни то, ни другое не «нет runnable-сценария». На текущем этапе `plugin-loads` и
`create` проходят, но остальные canonical id остаются `pending-migration`, поэтому полный
прогон завершается кодом `4` — это и есть честный отчёт о незавершённой миграции, а не
зелёный итог.

### Паритет

- **structural parity** — один canonical registry, одинаковые metadata, инструкции,
  assertions, profile, env и files для V1 и V2;
- **behavioral parity** — одинаковый ожидаемый результат на обоих host kinds.

Паритетная таблица отчёта: `scenario | V1 | V2 | parity | evidence` — **одна строка на каждый
выбранный canonical-сценарий**, в любом режиме. `—` в колонке хоста означает, что эта сторона
не дала результата, а причина названа в колонке `parity` и в доказательстве. Допустимые
значения `parity`:

| parity    | Когда                                                                                                                                      | Exit code                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `pass`    | обе стороны `pass` — одинаковая ожидаемая семантика                                                                                        | не влияет                                |
| `limited` | полного behavioral parity нет: одна сторона `blocked`, обе стороны ограничены одинаково, **или в прогоне измерялся только один host kind** | не влияет (`blocked` считается отдельно) |
| `fail`    | стороны ведут себя по-разному или хотя бы одна сторона `fail`                                                                              | `1`                                      |
| `not-run` | сценарий не мигрирован (`pending-migration`) или сторона не запустилась (`live-environment-unavailable`)                                   | `4` / `5`                                |

`blocked` никогда не считается `pass`. Сценарий с недоступной стороной не исчезает из
таблицы: результат работавшей стороны остаётся в своей колонке, а строка получает
`not-run` с причиной — сравнение не теряется в разрозненных таблицах. Матрица
`scenario | required on V1 | required on V2 | expected status | reason` строится из
canonical registry, а не из ручной таблицы: каждый canonical-сценарий обязателен на обоих
host kinds.

Кодовый путь тот же: `not-run`-строки этой таблицы — вход `aggregateExitCode`, поэтому
отчёт и код выхода не могут расходиться.

Отчёт пишется в `docs/plans/host-smoke.md` и содержит один общий набор строк для V1 и V2.

## Как выбрать V1/V2

| Команда                          | Что запускается                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `mise run smoke`                 | parity-прогон: canonical-сценарии через V1 **и** V2 один за другим, одна parity-таблица                            |
| `HOST_SMOKE_OPENCODE_VERSION=v1` | проверка одного хоста: только V1; строка паритета получает `limited` — вторая сторона в этом прогоне не измерялась |
| `HOST_SMOKE_OPENCODE_VERSION=v2` | то же для V2                                                                                                       |
| `HOST_SMOKE_BASELINE=1`          | устаревший runner выбранного хоста, только для сравнения; parity report не формирует                               |

Бинарники: по умолчанию `/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode` (V1) и
`/opt/homebrew/Cellar/opencode-v2/2.0.16/bin/opencode` (V2); переопределяются
`HOST_SMOKE_V1_BINARY` и `HOST_SMOKE_V2_BINARY`. Если явно выбранный хост не отвечает
ожидаемому контракту, запуск завершается понятной ошибкой этого адаптера — подмены
V1 на V2 (или наоборот) нет. Поддерживаются ровно эти две версии; никаких других,
неизвестных или будущих версий OpenCode suite не обещает.

## Какие возможности нужны сценариям

| Сценарий               | Что использует в общем фасаде                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `plugin-loads`         | создание сессии, `runPrompt`, нормализованные tool calls, plugin evidence                                           |
| `create`               | создание сессии, `runPrompt`, `readWorkflowState` (durable `currentStage`)                                          |
| `no-session`           | создание сессии, `runPrompt`, нормализованный shell-вызов, `readWorkflowState` (durable state должен отсутствовать) |
| consent-сценарии       | ответы оператора: `question` в V1, формы в V2                                                                       |
| task/mutation/pipeline | durable state, HEAD и квитанция, safe retry для мутаций                                                             |

Хост называет shell-инструмент по-разному (V1 — `bash`, V2 — `shell`), поэтому общий
контракт использует одно имя `SHELL_TOOL = 'shell'`: иначе утверждение «команда выполнена»
пришлось бы ветвить по версии хоста внутри сценария.

## Стадийная миграция

Новая реализация создана рядом со старой, миграция по этапам:

1. **Сделано (этап 1):** вертикальный срез — `SmokeHost`, две transport strategy, один
   runner, canonical registry, `plugin-loads` и `create`, parity report и единый exit code.
2. **Сделано (этап 2):** `no-session` (stage-2-core) — тот же registry, facade, runner и
   parity pipeline; утверждение — «durable workflow state не появился **и** команда
   действительно выполнилась».
3. Дальше: consent, task, negative, commit, subagent и pipeline-сценарии.
4. Baseline runner (`scenario-kit.ts`, `v2-scenario-kit.ts`, `v2-client.ts`) остаётся
   до миграции последнего сценария и **не** формирует parity report; он не получает
   новых сценариев и новых semantics.

Retry-семантика каждого мигрированного шага зафиксирована в registry: `plugin-loads` и
`no-session` — read-only с повтором в той же сессии, `create` — mutating с одной попыткой.
Полный контракт safe retry (`poll-state`, `new-session`, `indeterminate_mutation`)
становится обязательным при миграции mutating-, consent-, task- и subagent-сценариев,
и registry, объявивший ещё не реализованную strategy, отклоняется до старта хоста.

### Таймауты и retry

- Mutating-инструкция **никогда** не повторяется в той же stateful-сессии: если
  ожидание не выполнено, runner читает durable исход через фасад, и недоказуемый
  результат становится `blocked` с `indeterminate_mutation`, а не второй мутацией.
- Промпт, оборвавшийся исключением, — та же ситуация для мутации: неизвестно, дошла ли
  инструкция до хоста. Runner не повторяет её и не объявляет `fail` наугад: он сначала
  читает durable state, и
  - если состояние подтверждает ожидание шага — это `pass` с пометкой в evidence, что
    промпт не вернулся, а исход доказан сохранённым состоянием;
  - если состояние недоступно, пусто или ожидание не подтверждает — `blocked` с
    `indeterminate_mutation` (запрос мог всё ещё выполняться).
- Обычный `fail` остаётся только для доказанного случая: ход завершился, ожидание не
  выполнено, и сохранённого изменения нет.
- `poll-state` (следующий этап) не повторяет mutating prompt: он ждёт durable
  state/operation status до ограниченного дедлайна.
- Незавершённый ход хоста не считается автоматически успешным: шаг судится по
  ожиданию, а evidence сообщает и таймаут, и число попыток.

## Что осталось в фасаде, а что в плагине

`blocked` с причиной `adapter_contract_mismatch` у V1/V2 возникает из-за контракта
**хоста**, и такие различия исправляются в facade: endpoints против generated client,
Basic Auth, plugin config (`plugin: ["file://…"]` против `plugins: [{package}]`),
`question` против форм, agent в сообщении против `switchAgent`, нормализация частей
сообщения.

Классификация несовпадений текущего набора:

| Несовпадение                                                                 | Класс              | Где исправлено                                                |
| ---------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------- |
| разные endpoint-ы и типы ответов                                             | transport-only     | обе strategy, общая нормализация                              |
| Basic Auth и пароль сервера V2                                               | transport-only     | `harness.ts`, `v2-client.ts`                                  |
| agent в сообщении (V1) против `switchAgent` (V2)                             | transport-only     | обе strategy, один вход `PromptInput.agent`                   |
| `question` (V1) против форм (V2)                                             | transport-only     | обе strategy, один `operator.ts`                              |
| V2 не получал `commit-task.ts`, который получал V1                           | orchestration-only | общие файлы проекта в CLI/`scenarioHostOptions`               |
| V2 работал только с профилем `smoke` и без `env`/`files` сценария            | orchestration-only | canonical metadata в registry, один `startHost`               |
| V1 отдаёт tool-part лишь в списке сообщений, а не в ответе на промпт         | transport-only     | `v1-transport.ts` читает ход через `GET /session/:id/message` |
| V2 исполняет plugin tools через собственную обёртку и называет их в metadata | transport-only     | `transport.ts` нормализует вызов к имени плагинного tool-а    |
| отдельные runner-ы, registry и exit-code paths                               | orchestration-only | `runner.ts`, `registry.ts`, `parity.ts`                       |
| `blocked`/`not-run` были взаимозаменяемы                                     | orchestration-only | закрытые `BlockedReason` и `NotRunReason`                     |

Два transport-различия в таблице найдены живым прогоном: baseline-assertion `plugin-loads`
судила по тексту модели и потому не замечала, что в V1 tool-part приходит в другом
сообщении того же хода, а в V2 носит имя обёртки. Обе нормализации сделаны внутри
strategy, поэтому общий сценарий снова видит одинаковый `NormalizedToolCall`.

Изменений в production plugin не требуется: `plugin-contract-mismatch` не доказан,
поэтому `src/` не менялся, а вся разница V1/V2 осталась в facade и его strategies.

## Границы импортов

`smoke/` — внешний потребитель собранного плагина. Он **не** импортирует ни исходники,
ни типы production plugin из `src/`, `dist/` или внутренних модулей, включая
`import type`: обратная compile-time зависимость сделала бы сценарий зелёным из-за
совпадения типов, а не из-за поведения собранного артефакта. За этим следит
`no-restricted-imports` в `eslint.config.js`.

Всё, что нужно сценариям, объявлено локально в `smoke/src/host/types.ts`; внешний JSON
сужается вручную. Отдельный публичный contract package не создавался.

## Результаты этапа 1 (вертикальный срез)

Живой прогон 2026-09-27, модель `crpt/deepseek-ai/DeepSeek-V4-Flash-small`, собранный
`dist`:

| Проверка                          | Команда                                                                            | Итог                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| structural parity                 | `bun test smoke/`                                                                  | 125 pass: один registry, одинаковые metadata, одинаковые assertions                             |
| `plugin-loads` на V1              | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke plugin-loads`                       | **ПРОЙДЕНО**, 1 попытка, 38.2s, exit `0`                                                        |
| `plugin-loads` на V2              | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke plugin-loads`                       | **ПРОЙДЕНО**, 1 попытка, 3.8s, exit `0`                                                         |
| behavioral parity обоих сценариев | `mise run smoke plugin-loads create`                                               | 4/4 **ПРОЙДЕНО** (V1 33.7s и 30.9s, V2 4.3s и 2.5s), parity `pass`, exit `0`                    |
| полный canonical registry         | `mise run smoke`                                                                   | 4/4 **ПРОЙДЕНО**, остальные 9 — `not-run`/`pending-migration`, exit `4`                         |
| недоступная среда                 | `HOST_SMOKE_V2_BINARY=/nonexistent/v2 mise run smoke create`                       | V1 **ПРОЙДЕНО**, V2 `not-run`/`live-environment-unavailable`, exit `5`                          |
| выбор только из pending           | `mise run smoke no-session`                                                        | на этапе 1: `not-run`/`pending-migration`, exit `4` (после миграции — проверка самого сценария) |
| baseline                          | `HOST_SMOKE_BASELINE=1 HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke plugin-loads` | **ПРОЙДЕНО**, exit `0`                                                                          |

Baseline тех же сценариев до миграции: `plugin-loads` и `create` на V1 — 2/2
**ПРОЙДЕНО** (exit `0`), `v2-workflow-create` на V2 — 1/1 **ПРОЙДЕНО** (exit `0`).

Оговорка: полный прогон завершается `4`, пока не мигрированы остальные
canonical id — это и есть честный признак незавершённого этапа, а не зелёный итог.

## Результаты этапа 2 (`no-session`)

| Проверка           | Команда                                                    | Итог                                                                                                                     |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `no-session` на V1 | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke no-session` | **ПРОЙДЕНО**, 1 попытка, 1.4m, exit `0`                                                                                  |
| `no-session` на V2 | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke no-session` | **ПРОЙДЕНО**, 1 попытка, 3.2s, exit `0`                                                                                  |
| behavioral parity  | `mise run smoke no-session`                                | 2/2 **ПРОЙДЕНО** (V1 1.5m, V2 2.9s), parity `pass`, exit `0`                                                             |
| полный registry    | `mise run smoke`                                           | 6/6 **ПРОЙДЕНО** (три сценария × два хоста), 8 сценариев `not-run`/`pending-migration`, `no-session` со `pass`, exit `4` |
| structural parity  | `bun test smoke/`                                          | 149 pass, включая проверку одинаковых metadata, instruction, mutation, retry и assertion для обоих host kind             |

Утверждение этого этапа — «ровно разрешённое действие», и оно проверяет:

1. `workflowState === null` — durable workflow state не появился;
2. **ровно один** tool call за попытку (лишние запрещены: инструкция требует
   «Do nothing else», а дополнительный shell-вызов может изменить рабочее дерево или
   окружение);
3. нормализованное имя — `shell`;
4. `command === 'git log --oneline -1'` (после нормализации пробелов);
5. `status === 'completed'` и вывод содержит seed-коммит временного проекта.

Считаются только tool calls: обычный текстовый ответ модели после вызова не нарушает
контракт. Лишние действия в одной попытке делают её невыполненной, поэтому read-only шаг
повторяется в той же сессии (до `HOST_SMOKE_ATTEMPTS`), и evidence сохраняет факт первой
неудачной попытки («попытка 1: разрешено ровно одно действие…»). Если лишние действия
есть во всех попытках — `fail` с `failureKind: 'model'`.

Этот контракт **специфичен для `no-session`** и не распространяется на остальные сценарии
автоматически: для каждого из них «ровно эти действия» должно быть отдельно объявлено
частью acceptance.

Без проверки «ровно одно действие» сценарий доказывал бы только, что `git log --oneline -1`
когда-то выполнялась, а не что модель сделала ровно разрешённое. Без `command` подошла бы
любая команда, печатающая `seed`, — например `echo seed`. Поэтому `NormalizedToolCall`
несёт `command`, а не только `output`: оба хоста сообщают его в `state.input.command`
(V1 `bash`, V2 `shell`), и сценарий сравнивает фактически выполненную команду с инструкцией,
а не текст транскрипта.

Что лишние действия — не гипотеза, показал живой прогон ещё до введения строгого контракта:
в evidence V2-стороны отчёта было видно **две** команды за один ход —
`shell:completed «git log --oneline -1»` и `shell:completed «echo "f360307 seed"»`. На
прежнем утверждении это принималось как `pass`; по строгому контракту такая попытка
невыполнена. После введения контракта тот же живой прогон V2 дал ровно один вызов и прошёл
с первой попытки:

```
tools=[shell:completed «git log --oneline -1»]; stage=(none)
```

## Результаты этапа 3 (`plan-consent`)

Сценарий согласия — первый, где нужен ответ оператора, поэтому фасад получил нормализованный
interaction, а runner — безопасный `poll-state`:

- `NormalizedInteraction { kind: 'question' | 'form'; id; isConsent; decision; label; offered }` —
  V1 `question` и V2 форма приводятся к одной записи; сценарий видит только её, а `id`/`kind`
  служат evidence и не дают добраться до хоста; `isConsent` отмечает interaction, который нёс
  собственный тег согласия плагина (`<consent-request …>`);
- `PromptInput.decision` — решение оператора (по умолчанию `grant`), которое strategy
  переводит в метку/значение конкретного хоста;
- `PromptResult.interactions` — что именно было отвечено в этом ходу;
- `SmokeWorkflowState.refs` — durable-запись ссылок плагина (`refs.plan`), которая доказывает
  применение согласия, в отличие от самого факта ответа.

Утверждение сценария (после `workflow-create`):

1. `interactions` содержит interaction с `isConsent: true` и решением `grant` — согласие реально
   прошло через фасад. Именно `isConsent`, а не любой `grant`: иначе придуманный моделью
   лишний вопрос с ответом «grant» удовлетворял бы проверку, ничего не доказывая
   (`kind` говорит, какая поверхность хоста спросила, `isConsent` — что именно спросили);
2. `workflowState.refs.plan` записан;
3. `currentStage === 'tasks_ready'` — машина вышла из `planning`.

Retry-политика: consent — mutating-шаг, `same-session` для него запрещён. Объявлен
`poll-state`: инструкция отправляется **один раз**, дальше runner читает durable store до
бюджета `HOST_SMOKE_STATE_POLL_MS` (по умолчанию 5000 мс) и не повторяет мутацию. Если исход
доказан состоянием — `pass` с пометкой в evidence; если состояние недоступно или ничего не
подтверждает — `blocked` с `indeterminate_mutation`.

`HARNESS_AUTO_APPROVE` в canonical-сценарии **не** выставляется: с ним плагин одобряет
согласие сам (`consent-orchestrator.ts`), и сценарий проходил бы, не доказав, что ответ
оператора вообще доехал. Это единственное намеренное расхождение с baseline-metadata
(зафиксировано и в тесте, и в registry).

| Проверка                    | Команда                                                                                     | Итог                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `plan-consent` на V1        | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke plan-consent`                                | **ПРОЙДЕНО**, 2 шага, 1.7m, exit `0`                                     |
| `plan-consent` на V2        | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke plan-consent`                                | **ПРОЙДЕНО**, 2 шага, 9.6s, exit `0`                                     |
| behavioral parity           | `mise run smoke plan-consent`                                                               | 2/2 **ПРОЙДЕНО** (V1 1.6m, V2 10.2s), parity `pass`, exit `0`            |
| накопленный subset на V1    | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke plugin-loads create no-session plan-consent` | 4/4 **ПРОЙДЕНО**, exit `0`                                               |
| накопленный subset на V2    | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke plugin-loads create no-session plan-consent` | 4/4 **ПРОЙДЕНО**, exit `0`                                               |
| полный registry             | `mise run smoke` (два прогона)                                                              | 19/20 и 17/20 **ПРОЙДЕНО**, exit `1`                                     |
| migrated subset (оба хоста) | `mise run smoke plugin-loads create no-session plan-consent`                                | 8/8 **ПРОЙДЕНО** (четыре сценария × два хоста), exit `0`                 |
| полный canonical registry   | `mise run smoke`                                                                            | 8/8 **ПРОЙДЕНО**, семь сценариев `not-run`/`pending-migration`, exit `4` |
| structural parity           | `bun test smoke/`                                                                           | 164 pass, включая metadata, стратегии и assertion обоих host kind        |

### Ошибка модели против ошибки host/plugin

Живой прогон может провалиться из-за того, что модель не выполнила инструкцию, и это **не**
доказательство поломки V1/V2. Поэтому результат `fail` несёт `failureKind`, вычисленный по
тому, что увидел адаптер:

| failureKind | Что наблюдалось                                                                                                                                         | Как читать                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `model`     | ни одного **завершённого** вызова инструмента плагина: инструкция не дошла до плагина (модель вызвала не тот tool, неверные аргументы, лишние действия) | поведение host/plugin не наблюдалось → сценарий `fail`, прогон нужно повторить |
| `host`      | вызов инструмента плагина **завершился**, а ожидание шага всё равно не выполнено (или плагин вернул ошибку, или V1/V2 нормализовали разное)             | наблюдаемое поведение host/plugin → это может быть дефект паритета             |
| `unknown`   | инструмент плагина вызывался, но ни один вызов не завершился; либо необработанная ошибка                                                                | решает транскрипт; прогон нужно повторить                                      |

`failureKind` есть только у `fail`; `blocked` и `pass` его не несут (инвариант проверяется
`assertScenarioResultInvariant`). Evidence печатает и класс отказа, и фактические вызовы:
`tools=[workflow-create:failed]`.

Следствие для паритета: `V1 pass / V2 fail` становится `parity: fail` только когда на
провалившейся стороне плагин действительно работал (`failureKind: host`). Провал по вине
модели даёт `parity: limited` с явным «behavioral parity не подтверждён» и требованием
повторить прогон — иначе случайность живой модели выглядела бы как дефект контракта хоста.

Правило приёмки живой проверки: одна неудачная попытка из-за живой модели не подтверждает
дефект реализации. Сохраняем evidence фактического вызова, проверяем, был ли вызван
ожидаемый инструмент, читаем durable state, повторяем прогон (для read-only шага вроде
`plugin-loads` повтор разрешён), и только если результат остаётся неопределённым —
фиксируем, что behavioral parity не подтверждён.

`create` — mutating-шаг: он **не** повторяется автоматически. Если модель ошиблась и durable
state не изменился, это честный `fail`; повтор допустим только как новая отдельная scenario
session и только по явно разрешённой политике (этап миграции mutation-сценариев). Если вызов
мог выполниться, а результат неизвестен — `blocked` с `indeterminate_mutation`.

### Retry policy первого этапа

На первом vertical slice не выполняй общий redesign mutating retries. Для `plugin-loads` и
`create` зафиксирована текущая семантика: `plugin-loads` — read-only с повтором в той же
сессии, `create` — одна попытка без повтора. Новый запрет повторной мутации в той же сессии,
`poll-state`, `indeterminate_mutation` и `new-session` становятся обязательными при миграции
mutation/consent/task/subagent-сценариев.

## Результаты этапа 4 (`task-control`, `verify-loop`)

Этап вводит в общий runner всё, что нужно петле задач: шаг может работать другим агентом
(`ScenarioStep.agent`), ждать дольше бюджета промпта (`stateBudgetMs`) и читать из состояния
не только стадию, но и то, как хост видит работу.

Новое в нормализованном контракте:

- `NormalizedToolCall.refused` — структурированный маркер отказа плагина (`metadata.refused`):
  отказ — это **успешный** результат вызова, поэтому маркер читается раньше статуса;
- `SmokeWorkflowState.changedFiles` — файлы, которые ядро записало как изменённые; вердикт
  шага строится по ним, а не по отчёту модели;
- `SmokeWorkflowState.runs` — прогоны задач: какая задача, на какой подстадии, какие гейты
  закрыты. Цикл проверки доказывается ими;
- `subagentStep()` — общий конструктор шага, который диспатчит субагента и ждёт durable-исход,
  а не ответ модели; V2 для этого переключает агента сессии (`switchAgent`), V1 называет агента
  в сообщении.

Порядок доказательства отказа (`task-control`, шаг worker): сначала состояние задачи обязано
остаться `pending`, затем ищется сам вызов `workflow-tasks-set-status`, и только потом читается
маркер отказа. Если durable-статус сдвинулся — это `fail` независимо от того, что сказала модель.

| Проверка             | Команда                                                      | Итог                                                                                              |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `task-control` на V1 | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke task-control` | **ПРОЙДЕНО**, 3 шага, 10.1s, exit `0`                                                             |
| `task-control` на V2 | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke task-control` | **ПРОЙДЕНО**, 3 шага, 1.1m, exit `0`                                                              |
| `verify-loop` на V1  | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke verify-loop`  | **ПРОЙДЕНО**, 6 шагов, 1.5m, exit `0`                                                             |
| `verify-loop` на V2  | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke verify-loop`  | **ПРОЙДЕНО**, 6 шагов, 1.6m, exit `0` (ход превысил бюджет промпта, исход подтверждён состоянием) |
| behavioral parity    | `mise run smoke`                                             | семь сценариев × два хоста = 14/14 **ПРОЙДЕНО**, parity `pass` у всех, exit `4` (четыре pending)  |
| structural parity    | `bun test smoke/`                                            | 185 pass                                                                                          |

### Найденный дефект: имя инструмента диспатча

Хост сообщает субагентский диспатч как `task` на V1 и как `subagent` на V2. Гарды, инварианты
и разбор `<workflow-result>` написаны против одной возможности, поэтому на V2 субагент выполнял
работу и сообщал вердикт, а плагин не записывал ни файлов, ни гейтов, ни завершения задачи:
цикл проверки «проходил» без единого записанного результата. Дефект закрыт картой алиасов в
`normalizeTool` (`subagent → task`, `shell → bash`, позднее `patch → apply_patch`) — это
`plugin-contract-mismatch`, доказанный живыми прогонами, а не догадка.

## Результаты этапа 5 (`git-block`)

Сценарий доказывает, что прямой `git commit --allow-empty -m "smoke"` внутри управляемой
сессии отклоняется, и что отказ не оставил разрешения на поставку.

Порядок доказательства (всё, что можно, — из durable-состояния, а не из слов модели):

1. `workflow-create` выполняется до попытки коммита: сначала durable-сессия на стадии `planning`,
   и только потом guarded-команда;
2. `workflowState.deliveryReceipt` отсутствует — квитанция о поставке не записана;
3. `workflowState.deliveryPermit` отсутствует — разрешение коммитить не выдано;
4. вызов `shell` относится именно к этой команде (нормализованное поле `command`);
5. структурированный маркер отказа (`refused`), затем статус вызова: `completed` без отказа —
   это `fail` («commit выполнился, хотя должен был быть отклонён»);
6. текст отказа — только документированный fallback, когда хост не сообщил ни маркера, ни
   ошибки. На V2 маркер не доезжает (обёртка снимает `metadata`), поэтому отказ приходит как
   ошибка вызова `shell:failed`, и это видно в evidence.

Retry-политика шага — `none`: команда меняет состояние git, повтор после таймаута мог бы
закоммитить по-настоящему, а ожидаемый отказ повтора не требует. Если ход превысил бюджет
промпта и состояние не доказывает, что команда не выполнялась, шаг получает
`blocked/indeterminate_mutation`, а не `pass`.

Evidence пары прогонов совпадает по нормализованным фактам:

```text
tools=[shell:failed «git commit --allow-empty -m "smoke"»]; stage=planning; delivery=none
```

| Проверка                  | Команда                                                                                                                        | Итог                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `git-block` на V1         | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke git-block`                                                                      | **ПРОЙДЕНО**, 2 шага, 8.5s, exit `0`                                        |
| `git-block` на V2         | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke git-block`                                                                      | **ПРОЙДЕНО**, 2 шага, 5.6s, exit `0`                                        |
| behavioral parity         | `mise run smoke git-block`                                                                                                     | 2/2 **ПРОЙДЕНО** (V1 10.6s, V2 5.2s), parity `pass`, exit `0`               |
| накопленный subset на V1  | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke plugin-loads create no-session plan-consent task-control verify-loop git-block` | 7/7 **ПРОЙДЕНО**, exit `0`                                                  |
| накопленный subset на V2  | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke plugin-loads create no-session plan-consent task-control verify-loop git-block` | 7/7 **ПРОЙДЕНО**, exit `0`                                                  |
| полный canonical registry | `mise run smoke`                                                                                                               | 14/14 **ПРОЙДЕНО**, четыре сценария `not-run`/`pending-migration`, exit `4` |
| structural parity         | `bun test smoke/`                                                                                                              | 185 pass                                                                    |

### Найденный дефект: имена инструментов и аргументов на V2

V2 называет патч `patch` (V1 — `apply_patch`), а аргумент пути передаёт как `path`
(V1 — `filePath`). Гарды стадии построены на именах V1, поэтому на V2 извлечение путей
возвращало пустой список, и допуск отказывал в правке, которая на самом деле в объявленном
скоупе. Субагент-кодер получал отказ на каждую запись и повторял её — прогон выглядел как
многоминутный простой, а `changedFiles` оставался пустым.

Исправлено в плагине, без обхода публичного контракта:

- `src/rules/message-paths.ts` — путь читается и из `filePath`, и из `path`; добавлен `patch`;
- `src/app/runtime-session-context.ts` — алиас `patch → apply_patch` рядом с существующими;
- `src/app/change-enforcement.ts` — путь приводится к project-relative перед сверкой со
  скоупом (V2 присылает абсолютный путь, V1 — относительный).

## Результаты этапа 6 (`commit-gate`, `commit-cwd`, `commit-mismatch`)

Три сценария поставки — первый класс, где ожидается **настоящая мутация**: команда
`commit-task.ts` перемещает HEAD, плагин выдаёт или не выдаёт квитанцию, а выданное разрешение
может перестать действовать. Поэтому доказывать здесь что-либо словами модели нельзя, и этап
добавил в контракт шага наблюдаемую сторону рабочего каталога.

Новое в контракте (только наблюдаемое снаружи, без внутренних типов плагина):

- `StepWorkspace { workDir, headBefore, headAfter }` — ожидание шага получает его вторым
  аргументом: git HEAD до инструкции и на момент проверки;
- `ScenarioStep.prepare(workspace)` — подготовка каталога до инструкции, ровно один раз за шаг
  (это мутация): так `commit-mismatch` создаёт `unrelated.txt`, которого workflow не видел;
- `SmokeHost.workDir` — проект прогона как часть контракта сценария: git одинаков для обоих
  host kinds, и наблюдение за ним не принадлежит ни одному из них;
- `SmokeWorkflowState.stageGates` — гейты стадий по id (`review`, `qa`), которыми доказывается,
  что вердикты доехали до стадии;
- `SmokeWorkflowState.runs[].checks` — вердикт ядра о ходе задачи.

Каждый `pass` печатает наблюдаемые факты поставки, а не пересказ:

```text
commit-cwd      delivery=receipt:cb28b9c6…;  head=1ec7dbff→cb28b9c6; files=["src/smoke-1.ts"]
commit-mismatch stage=commit; delivery=none;  head=dd9b8ccc→a047d3d9; files=["src/smoke-1.ts"]
commit-gate     delivery=none;               head=5ff236fb→5ff236fb; files=[]
```

### Порядок доказательства

| Сценарий          | Инварианты, которые проверяются                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `commit-gate`     | HEAD не сдвинулся; `deliveryReceipt` отсутствует; `deliveryPermit` не выдан; команда отклонена |
| `commit-cwd`      | HEAD сдвинулся; `deliveryReceipt` присутствует и **равен новому HEAD**; файл записан ядром     |
| `commit-mismatch` | HEAD сдвинулся (коммит состоялся), но квитанции нет, а выданное разрешение больше не действует |

Порядок разбора отказа команды один для всех трёх: структурированный маркер отказа → факт
выполнения команды (`completed` без отказа — это `fail`) → текст отказа как документированный
fallback для хоста, который не сообщил ни маркера, ни ошибки.

Retry-политика: все шаги поставки — `mutating` + `poll-state`. Инструкция отправляется **один
раз**, дальше runner читает состояние до бюджета и не повторяет команду; `same-session` для
мутирующего шага запрещён валидацией реестра. Если ход превысил бюджет и состояние не
доказывает, что команда не выполнялась, шаг получает `blocked/indeterminate_mutation`, а не
`pass` и не `fail`.

### Результаты

| Проверка                        | Команда                                                             | Итог                              |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| `commit-gate` на V1 / на V2     | `HOST_SMOKE_OPENCODE_VERSION=v1\|v2 mise run smoke commit-gate`     | **ПРОЙДЕНО** обоих (12.3s / 5.2s) |
| `commit-cwd` на V1 / на V2      | `HOST_SMOKE_OPENCODE_VERSION=v1\|v2 mise run smoke commit-cwd`      | **ПРОЙДЕНО** обоих (1.6m / 30.7s) |
| `commit-mismatch` на V1 / на V2 | `HOST_SMOKE_OPENCODE_VERSION=v1\|v2 mise run smoke commit-mismatch` | **ПРОЙДЕНО** обоих (1.6m / 1.5m)  |
| все три на обоих хостах сразу   | `HOST_SMOKE_OPENCODE_VERSION=v1\|v2 mise run smoke <три сценария>`  | 6/6 **ПРОЙДЕНО**, exit `0`        |
| parity-тройка (повтор)          | `mise run smoke commit-gate commit-cwd commit-mismatch`             | 6/6 **ПРОЙДЕНО**, exit `0`        |
| накопленный subset на V1        | `HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke <десять сценариев>`  | 10/10 **ПРОЙДЕНО**, exit `0`      |
| накопленный subset на V2        | `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke <десять сценариев>`  | 10/10 **ПРОЙДЕНО**, exit `0`      |

Про полный registry: в нём двадцать ног (десять сценариев × два хоста), и в обоих прогонах
падали только ноги с вердиктами субагентов — тестировщик не выставлял `<workflow-result>`, либо
гейт `review` оставался незакрытым, либо согласие не проходило через фасад. Каждый из этих
сценариев в отдельных прогонах и в накопленных subset проходит на обоих хостах, поэтому это
дисциплина живой модели, а не расхождение контракта; harness называет такие ноги
`failureKind=model` и пишет «behavioral parity не подтверждён, прогон нужно повторить». Код
выхода `4` (только незавершённая миграция `cicd-full-cycle`) требует, чтобы все двадцать ног
были чистыми, и в этом окружении это зависит от того, как модель проведёт вердикты.

### Найденный дефект: ход не ограничивался бюджетом целиком

Полный прогон registry показал шаг, который шёл **1123 s** при объявленном бюджете промпта 60 s
и бюджете состояния 20 s. При этом сам шаг честно сообщал `ход хоста не завершился за бюджет
промпта`, то есть бюджет _обнаруживался_, но не ограничивал ожидание: клиент V2 ограничивает
каждый отдельный вызов (`prompt`, `wait`, обход форм), а ход состоит из нескольких — и залипший
вызов между ними оставлял шаг ждать.

Исправлено в фасаде: бюджет применяется к ходу целиком (`promptWithinBudget`), одинаково для
обоих хостов, а истёкший ход возвращается как `timed-out` — то есть тот же исход, который runner
уже умеет читать из состояния, не повторяя мутацию.

## Что изолируется, а что заимствуется

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` и `XDG_CACHE_HOME` указывают на
временное дерево, поэтому ваши агенты, плагины, MCP-серверы и сессии в прогоне не
участвуют. Из окружения заимствуются две вещи — без них не будет живой модели:
совпадающие записи из `provider`/`providers` вашего конфига opencode и `auth.json`.
`HOST_SMOKE_MODEL` (или `model` верхнего уровня в конфиге) определяет, какие имя
провайдера и id модели останутся; остальные провайдеры удаляются.

Проект, в котором работает хост, — свежий git-репозиторий с профилем сценария,
`commit-task.ts` и файлом плана. По окончании прогона он удаляется.

## Модель — часть теста

Живая модель сама решает, вызывать ли инструмент, который её просили вызвать, поэтому
шаг может упасть из-за модели, а не из-за плагина. Read-only шаг повторяется
(`HOST_SMOKE_ATTEMPTS`, по умолчанию 3), mutating — нет. **Шаг, которому понадобились
повторы, — проблема промпта; шаг, не прошедший ни разу, — находка.** Не используйте
фиксированную длительность как порог pass/fail.

V2 ограничивает один промпт бюджетом `HOST_SMOKE_PROMPT_TIMEOUT_MS` (по умолчанию 60 с):
ход, вышедший за бюджет, не является вердиктом, а сообщается в evidence как
`timed-out`. Дальше шаг судится по durable state, который сохранил плагин.

Один наблюдавшийся baseline-прогон с живой моделью (историческая оценка старого
runner-а, не текущий набор):

| Сценарий          | Попыток | Длительность |
| ----------------- | ------: | -----------: |
| `plugin-loads`    |       1 |        17.3s |
| `no-session`      |       1 |        14.4s |
| `create`          |       1 |        15.9s |
| `git-block`       |       1 |        30.2s |
| `task-control`    |       2 |        28.1s |
| `commit-gate`     |       1 |        26.1s |
| `commit-cwd`      |       1 |        56.1s |
| `commit-mismatch` |       8 |         2.7m |
| `cicd-full-cycle` |      10 |         8.0m |
| `verify-loop`     |       6 |         2.4m |

Свежие длительности каждый прогон записывает в `docs/plans/host-smoke.md`.

## Окружение

| Переменная                     | Значение                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| `HOST_SMOKE_MODEL`             | id модели; по умолчанию `model` из вашего конфига opencode    |
| `HOST_SMOKE_PLUGIN`            | не собирать, а загрузить этот путь вместо `dist`              |
| `HOST_SMOKE_ATTEMPTS`          | число попыток read-only шага, по умолчанию 3                  |
| `HOST_SMOKE_PROMPT_TIMEOUT_MS` | V2: бюджет одного промпта, по умолчанию 60000                 |
| `HOST_SMOKE_OPENCODE_VERSION`  | `v1` или `v2`: сузить прогон до одного host kind              |
| `HOST_SMOKE_V1_BINARY`         | путь к бинарнику V1                                           |
| `HOST_SMOKE_V2_BINARY`         | путь к бинарнику V2                                           |
| `HOST_SMOKE_BASELINE`          | `1`: запустить устаревший runner выбранного хоста (сравнение) |
| `HOST_SMOKE_DEBUG`             | печатать вопросы, обмен USER/MODEL и детали падений           |
| `HOST_SMOKE_OUTPUT`            | `human` (по умолчанию) или `jsonl`                            |
| `FORCE_COLOR=1`                | форсировать цвета, когда stderr не подключён к TTY            |
| `NO_COLOR=1`                   | отключить цвета                                               |

Для машинно-читаемого вывода используйте JSONL в stderr:

```bash
HOST_SMOKE_OUTPUT=jsonl HOST_SMOKE_DEBUG=1 mise run smoke 2>host-smoke.jsonl
```

Каждая строка — одно событие с `timestamp`, `type`, `message` и полями, специфичными
для события, например `scenario`, `hostKind`, `attempts` и `durationMs`. Многострочные
сообщения и доказательства остаются корректными JSON-строками. В человекочитаемом
режиме логи, доказательства и отчёт выводятся по-русски; при `HOST_SMOKE_OUTPUT=jsonl`
переводится только человекочитаемый текст, а имена событий и ключи JSON остаются
английскими.

## Что этот прогон выяснил про хост

- Плагин загружается из `file://` **каталога** (`file://…/dist`) — именно так его
  прописывает оператор в своём конфиге. Упакованный `.tgz` за `file://` **не**
  загружается: это стоит знать, прежде чем поставлять плагин таким способом.
- Хост читает список агентов один раз, при старте, поэтому агенты профиля должны
  быть на месте до подъёма сервера.
- Инструмент `question` — весь путь согласия — регистрируется только для
  интерактивных клиентов, если не задан `OPENCODE_ENABLE_QUESTION_TOOL`, и по
  умолчанию запрещён без `permission: { question: "allow" }`.
- `ToolContext.agent` действительно несёт имя вызывающего агента — именно против
  него работает `taskControlAgents`.
- V2 игнорирует унаследованный `OPENCODE_SERVER_PASSWORD`, генерирует собственные
  учётные данные и требует их при каждом вызове `/api`.
- V1 отдаёт результат хода по частям: ответ на `POST /session/:id/message` содержит
  только последнее сообщение хода, а tool-part лежит в предыдущем assistant-сообщении,
  которое видно через `GET /session/:id/message`.
- V2 исполняет plugin tools через свою обёртку (`execute`) и сообщает, какие именно
  плагинные tool-ы выполнились, в `state.metadata.toolCalls`; без этой нормализации
  `plugin-loads` не отличает вызов плагина от любого другого.

## Находки этого прогона

| Находка                                                                                                                                                                                     | Статус                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `workflow-tasks-set` сообщал об успехе, ничего не сохранив — реентрантная запись, перекрытая внешним save                                                                                   | исправлено (`SessionQueue`)                           |
| тег согласия нёс `revision`, которого не было в его собственном манифесте, и парсер плагина его отвергал                                                                                    | исправлено (`workflow-consent`)                       |
| обработчик ответа искал тег согласия в выводе инструмента, а не в вопросе                                                                                                                   | исправлено (`ConsentOrchestrator.after`)              |
| сама машина не выставляет гейты `review` и `qa`: их результат записывается из `<workflow-result>` подагента; поэтому без таких вердиктов поставляемая базовая машина не доходит до `commit` | уточнено сценариями `verify-loop` и `cicd-full-cycle` |

Это следует из `src/app/workflow-result-settler.ts`: для задачи код записывает
результат подагента строкой `run.gates[parsed.gate] = parsed.status === 'pass' ?
'passed' : 'failed'` и затем переводит задачу, когда все объявленные гейты
пройдены.
