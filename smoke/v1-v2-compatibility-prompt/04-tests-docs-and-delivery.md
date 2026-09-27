# Tests, documentation and delivery

### 10. Тесты

Добавь или обнови unit-тесты минимум для:

- общего scenario contract;
- V1 transport strategy внутри общего `SmokeHost`;
- V2 transport strategy внутри общего `SmokeHost`;
- выбор transport strategy внутри фасада;
- нормализации message parts;
- нормализации questions/forms;
- agent selection;
- plugin config для V1/V2;
- передачи `profile`, `env`, `files`;
- retry strategy;
- timeout без повторной мутации;
- cleanup при обычном результате и исключении;
- единого результата и отчёта;
- `SmokeHost.readWorkflowState()` и normalized durable workflow state;
- `blocked` статуса;
- хранения `not-run` только в `ParityReportEntry.parity`;
- обязательной причины `pending-migration` или
  `live-environment-unavailable` для каждого `not-run`;
- закрытых `blockedReason` и aggregate exit-code mapping;
- обязательного CLI aggregate mapping: `4` для pending migration и `5` для
  недоступной live-среды у migrated обязательного сценария;
- canonical registry без независимых V1/V2 списков;
- parity matrix и сравнение одинаковых scenario metadata;
- structural parity и behavioral parity;
- JSONL output.

Добавь тесты, что `blocked` создаётся только через закрытые runner/facade paths,
имеет допустимый `blockedReason`, evidence и ненулевой aggregate exit status.
Отдельно проверь negative parity: одинаковый ожидаемый refusal/guard outcome не
должен считаться расхождением только потому, что текст host/model различается.

Если изменён production plugin, дополнительно обязательно выполни:

```bash
mise run check
mise run build
```

При изменении host integration, plugin loading или собранных артефактов также
запусти применимый live smoke. Успешные smoke unit-тесты без plugin checks не
подтверждают корректность изменённого production contract.

Не подменяй интеграционные проверки только unit-тестами. Если live smoke нельзя
запустить, честно укажи это в отчёте.

На первом этапе обязательны проверки вертикального среза: общий facade и runner,
canonical registry с `plugin-loads` и `create`, одинаковые assertions для V1/V2,
unit-тесты обеих transport strategies и live `plugin-loads` **и** `create` через
V1 **и** V2. Если host или модель недоступны до запуска конкретного migrated
сценария, он получает `ParityReportEntry.parity: 'not-run'` с причиной
`live-environment-unavailable`, а результат не считается behavioral parity.
Такой результат возвращает aggregate exit code `5`; код `4` используется только
для `pending-migration`.
Полный parity consent/task/negative/commit/subagent/pipeline сценариев —
последующий этап.

`no-session` не входит в первый этап: он остаётся canonical registry entry со
статусом миграции `pending`, получает `ParityReportEntry.parity: 'not-run'` с
`notRunReason: 'pending-migration'` и не
создаёт `ScenarioResult` до следующего этапа.

Acceptance-команды с `create` являются post-migration checks первого vertical
slice. На baseline они не обязаны работать для V2, поскольку старый V2 registry
использует `v2-workflow-create`; до миграции baseline запускай только текущие
существующие команды и не объявляй их parity.
