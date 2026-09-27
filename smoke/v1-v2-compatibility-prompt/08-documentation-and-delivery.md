# Documentation and delivery

### 11. Документация

Обнови `smoke/README.md`.

Документация должна описывать:

- один общий `SmokeHost` interface и один общий scenario runner;
- две внутренние transport strategies: V1 и V2;
- различия transport implementations, скрытые внутри фасада;
- границу plugin contract и smoke transport;
- запрет импортов production plugin types из `src/`, `dist/` и внутренних модулей;
- локальные normalized types smoke и runtime narrowing для внешнего JSON state;
- какие несовпадения исправлены в plugin, а какие оставлены в facade;
- общий scenario contract;
- общий lifecycle и result format;
- смысл `PASS`, `FAIL`, `BLOCKED`;
- `not-run` только как значение `ParityReportEntry.parity`, всегда с причиной
  `pending-migration` или `live-environment-unavailable`, включая aggregate exit
  codes `4` и `5`;
- как выбрать V1/V2;
- как указать бинарник каждого варианта;
- какие сценарии требуют каких возможностей общего V1/V2 фасада;
- ограничения live model и retry.

README является baseline-документацией текущей реализации. Его описание двух
runner-ов и двух registry допустимо до миграции, но после изменения README должен
описывать только итоговый facade/runner. Не используй baseline README как источник
нового canonical contract.

Отдельно опиши timeout semantics: `poll-state` не повторяет mutating prompt,
незавершённый host turn не считается автоматически PASS, а недоказуемый результат
мутации становится `blocked` с `indeterminate_mutation`.

Опиши staged migration: первый этап оставляет текущий retry baseline для
`plugin-loads` и `create`, а safe retry contract становится обязательным при
последующей миграции mutating-сценариев. README должен различать `not-run` как
незавершённую миграцию в `ParityReportEntry.parity` и `blocked` как verdict
runnable-сценария. `ScenarioResult.status` допускает только
`pass | fail | blocked`.

Причина `not-run` обязательна: `pending-migration` означает незавершённую
миграцию и даёт aggregate exit code `4`; `live-environment-unavailable` означает,
что уже migrated обязательный сценарий не удалось запустить, и даёт exit code
`5`. Недоступная live-среда до запуска не является `blocked`; adapter capability
limitation остаётся `blocked` с `required_host_capability_unavailable`, а
transport/bootstrap exception — `fail` либо fatal exit code `2`.

Отдельно укажи, что первый этап включает только `plugin-loads` и `create`.
`no-session` переносится на следующий этап, остаётся в canonical registry как
pending migration и получает `ParityReportEntry.parity: 'not-run'` с
`notRunReason: 'pending-migration'`.

Не используй формулировки о поддержке произвольных или будущих версий OpenCode.

## Ограничения

- Не изменяй production plugin в `src/` без выполнения условий из
  `01-scope-and-context.md`.
- Если доказан `plugin-contract-mismatch`, минимальная правка production plugin
  разрешена и должна пройти обязательные plugin checks.
- Не добавляй новые зависимости без необходимости.
- Не добавляй version-check в каждый сценарий.
- Не копируй V1/V2 assertions в два независимых набора.
- Не оставляй новую и старую реализации двумя постоянными источниками истины.
- Compatibility bridge должен быть удалён после миграции всех сценариев, если его
  части не вошли в итоговый общий слой.
- Для каждого этапа новый общий runner authoritative для мигрированных сценариев;
  baseline runner только сравнивает старое поведение и не формирует parity report.
- Не выполняй полный retry redesign на первом этапе, если вертикальный срез можно
  завершить без него. Зафиксируй текущие retry semantics как baseline.
- Если facade и transport strategies покрывают первый срез без изменения plugin,
  plugin не изменяй. Plugin refactor остаётся исключением при доказанном
  `plugin-contract-mismatch`.
- Не скрывай проблему V1/V2 adapter-а fallback-переключением на другой adapter.
- Не удаляй существующие сценарии без обоснования.
- Не меняй уже имеющиеся пользовательские изменения в рабочем дереве.
- Перед изменением каждого файла выполни:
  `git diff HEAD -- <file>`
- После изменения каждого файла проверь:
  `git diff HEAD -- <file>`
- Не используй деструктивные git-команды.
- Соблюдай существующий стиль TypeScript.
- Технические артефакты и комментарии в коде пиши на английском, если локальные
  инструкции не требуют иного.
- Общайся с оператором на русском языке.

## Проверки

После реализации выполни:

```bash
bun test smoke/
git diff --check -- smoke/
```

Минимально проверь обе transport strategies через один и тот же canonical scenario:

```bash
HOST_SMOKE_OPENCODE_VERSION=v1 mise run smoke create
HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke create
```

Дополнительно проверь parity subset одних и тех же сценариев, включающий по
возможности загрузку plugin, создание сессии, consent/forms, task mutation,
negative refusal и commit flow. Не подменяй сравнение запуском разных сценариев.

Для первого этапа parity subset обязателен для обоих canonical-сценариев:
`plugin-loads` и `create`, через оба host kinds. Нельзя считать этап behavioral
parity, если live запускался только для `create`.

Если live-прогон не запускается, не имитируй его результат. Укажи:

- какая команда не запустилась;
- почему;
- какие unit-проверки прошли;
- какие свойства остались неподтверждёнными.

## Формат итогового отчёта

В конце верни:

1. краткое резюме решения;
2. список изменённых файлов;
3. какие части V1/V2 используют общий контракт;
4. какие V1/V2-различия изолированы в фасаде и внутренних strategies;
5. canonical registry и parity matrix всех сценариев;
6. structural parity report;
7. behavioral parity report с результатами одинаковых сценариев на V1 и V2;
8. какие сценарии получили `blocked`, с конкретной причиной и evidence;
9. результаты каждой проверки;
10. оставшиеся ограничения именно для V1/V2;
11. подтверждение, что решение не заявляет поддержку других версий OpenCode.

Если plugin изменён, дополнительно укажи:

12. конкретный contract mismatch, который потребовал plugin change;
13. почему smoke-only решение было недостаточным;
14. какие plugin checks и build artifacts проверены;
15. какие API и backward-compatibility guarantees сохранены.

Если smoke создаёт normalized types, дополнительно укажи:

16. где находятся общие smoke-типы;
17. какие V1/V2 host shapes они нормализуют;
18. подтверждение, что smoke не импортирует типы или исходники production plugin.

Если использовался compatibility bridge, дополнительно укажи:

19. какие baseline-файлы временно сохранялись;
20. какие сценарии были мигрированы по этапам;
21. какие bridge-файлы и legacy runner-ы удалены;
22. почему в итоговой архитектуре остался только один источник истины.

Для первого этапа дополнительно укажи baseline-результаты `plugin-loads` и
`create`, результаты этих же сценариев через V1 и V2 и последующие классы, которые
сознательно не мигрировались. Явно укажи, что `no-session` перенесён на следующий
этап, а записи этих сценариев хранят `ParityReportEntry.parity: 'not-run'` с
`notRunReason: 'pending-migration'`, что приводит к aggregate exit code `4`, даже
если `plugin-loads` и `create` прошли.
