# Assertions, results and parity

### 8. Assertions

Уменьши зависимость assertions от текста модели и wording host-а.

Предпочитать:

- durable workflow state;
- нормализованные tool calls;
- нормализованный status;
- проверку фактического файла;
- HEAD и receipt;
- структурированный tool result.

Regex по тексту вроде `/refus|blocked|workflow/i` используй только если нет
структурированного сигнала. В таком случае оставь комментарий с объяснением.

### 9. Единый результат и отчёт

V1 и V2 должны возвращать общий результат:

```ts
type BlockedReason =
  'adapter_contract_mismatch' | 'required_host_capability_unavailable' | 'indeterminate_mutation';

type ParityNotRunReason = 'pending-migration' | 'live-environment-unavailable';

interface ScenarioResult {
  id: string;
  title: string;
  hostKind: 'v1' | 'v2';
  status: 'pass' | 'fail' | 'blocked';
  attempts: number;
  durationMs: number;
  evidence: string;
  blockedReason?: BlockedReason;
}
```

`blocked` создаёт только общий runner или facade, никогда не сценарий через
произвольную строку. Он означает подтверждённое ограничение V1/V2 adapter
contract, недоступную обязательную возможность или неопределённый результат
мутации. Обязательны `blockedReason` из закрытого набора и evidence с operation,
hostKind, шагом и наблюдаемым ограничением. Инфраструктурное исключение, ошибка
plugin или непройденный assertion — это `fail`, а не `blocked`.

Закрытый набор `BlockedReason` применяется только к `blocked`. Недоступная live
среда до запуска не является `blocked`: она хранится как
`ParityReportEntry.parity: 'not-run'` с обязательной причиной
`live-environment-unavailable`. `pending-migration` используется только для
незавершённой миграции. Ни один `not-run` не допускается без причины.

`blocked` является результатом runnable-сценария и агрегируется в итог прогона.
`ScenarioResult.status` остаётся строго `pass | fail | blocked`. `not-run` не
является статусом scenario result: он хранится только в
`ParityReportEntry.parity` как состояние незавершённой миграции. Exit code:
`0` только если все обязательные runnable-сценарии `pass` и нет `not-run`; `1` при
любом `fail`; `2` при отсутствии runnable scenario или fatal adapter/bootstrap
error; `3` при наличии `blocked` и отсутствии `fail`; `4` при наличии только
`pending-migration`; `5` при наличии `live-environment-unavailable` для
обязательного migrated-сценария, если нет более приоритетного `fail`, fatal или
`blocked`. При одновременном наличии нескольких незавершённых состояний действует
приоритет `fail`/fatal (`1`/`2`), затем `blocked` (`3`), затем
`live-environment-unavailable` (`5`), затем `pending-migration` (`4`). На первом
этапе `plugin-loads` и `create` могут быть `pass`, но остальные canonical IDs
имеют `parity: 'not-run'` с причиной `pending-migration`, поэтому этап не
считается успешным и aggregate exit code равен `4`. Наличие `not-run` по причине
недоступной live-среды даёт `5`, а не `4`.
Это обязательное изменение первого общего runner-а и CLI aggregate path, а не
только документированная политика: текущий baseline `0/1` должен быть заменён
новым mapping, включая коды `4` и `5`. Не оставляй V1 и V2 раздельные exit-code
paths и не превращай `blocked` или `not-run` в успешный summary.

V2 не должен терять evidence при исключении.

Проверь, что:

- обычный режим печатает результаты;
- JSONL остаётся валидным;
- report file содержит V1 и V2 результаты в одной схеме;
- `blocked` не маскируется под `fail`;
- exit code соответствует текущей политике и документирован.

Не ломай существующий CLI без необходимости.

## Обязательное требование: фактический паритет V1/V2

Эта задача считается выполненной только при подтверждённом паритете, а не только
при наличии общего интерфейса. Паритет означает:

- один и тот же реестр сценариев запускается через V1 и V2;
- один и тот же сценарий использует одинаковые `id`, `title`, profile, env, files,
  инструкции, assertions и retry policy;
- V1 и V2 не получают разные сценарии только потому, что их transport различается;
- каждый сценарий, который объявлен поддерживаемым, имеет результат для обоих
  host kinds: `pass`, `fail` или `blocked` с объяснением;
- отсутствие поддержки конкретной операции в одном из двух host-контрактов не
  скрывается: результат `blocked` должен содержать конкретную причину;
- `blocked` не считается `pass`;
- тесты проверяют равенство реестров и scenario metadata для V1/V2;
- live smoke commands запускаются для одних и тех же сопоставимых сценариев на
  обоих host kinds, насколько это возможно в окружении.

Разделяй два результата:

- **structural parity** — один canonical registry, одинаковые scenario metadata,
  inputs, files, env, instructions, assertions и retry policy;
- **behavioral parity** — V1 и V2 дают одинаковую ожидаемую семантику сценария:
  positive scenario получает `pass/pass`, negative scenario получает одинаковый
  ожидаемый refusal/guard outcome, а одинаковый `blocked` допускается только при
  одинаковом подтверждённом host limitation.

`blocked` подтверждает только structural parity и наличие явно зафиксированного
ограничения. Если V1 получает `pass`, а V2 получает `blocked`, это не
`parity: pass`, а `limited parity`. Если V1 и V2 получают разные поведенческие
результаты без документированной host-причины, это дефект паритета.

Добавь parity matrix для всех текущих сценариев:

```text
scenario | required on V1 | required on V2 | expected status | reason
```

Не переводить сценарии в `blocked` только для того, чтобы скрыть незавершённую
реализацию V2. `blocked` допустим только при подтверждённом ограничении именно
соответствующего V1/V2 host-контракта, с конкретным evidence.

Добавь отдельный parity report или секцию итогового отчёта с таблицей:

```text
scenario | V1 status | V2 status | parity | evidence
```

Допустимые значения `parity`: `pass`, `limited`, `fail`, `not-run`. Источник
parity matrix — canonical registry и его typed metadata, а не ручная таблица.
Runner должен генерировать фактический parity report из результатов двух запусков;
ручная документация может объяснять причины, но не является источником статуса.

`ParityReportEntry` хранит `not-run`; это не расширение `ScenarioResult.status`:

```ts
interface ParityReportEntry {
  scenarioId: string;
  v1?: ScenarioResult;
  v2?: ScenarioResult;
  parity: 'pass' | 'limited' | 'fail' | 'not-run';
  notRunReason?: ParityNotRunReason;
  evidence: string;
}
```

Для первого этапа parity report обязан содержать все canonical IDs: `plugin-loads`
и `create` с результатами V1/V2, остальные — с `parity: 'not-run'` и
`notRunReason: 'pending-migration'`. `ScenarioResult` для незапущенных сценариев
не создаётся.

Не объявляй behavioral parity подтверждённым, если проверены только разные
smoke-наборы (`plugin-loads` для V1 и `v2-workflow-create` для V2). Минимум один и
тот же canonical smoke-сценарий должен быть запущен live через V1 и V2.

## Классы сценариев и порядок миграции

Классифицируй текущие сценарии:

- `stage-1-core`: `plugin-loads`, `create`;
- `stage-2-core`: `no-session`;
- `consent`: `plan-consent` и consent/forms сценарии;
- `task`: `task-control`, `verify-loop`;
- `mutation`: `commit-gate`, `commit-cwd`, `commit-mismatch`;
- `pipeline`: `cicd-full-cycle`.

Первый этап обязан закрыть только `stage-1-core`: `plugin-loads` и `create` на
обоих host kinds. `no-session` относится к `stage-2-core` и в первый этап не
входит. Остальные классы являются последующими этапами и не должны
заставлять исполнителя преждевременно расширять общий facade.

`blocked` допустим на последующих этапах только при конкретном доказанном
ограничении V1/V2 host contract. На первом core-этапе `blocked` не заменяет
реализацию: `plugin-loads` и `create` должны получить сопоставимый результат на
V1 и V2.
