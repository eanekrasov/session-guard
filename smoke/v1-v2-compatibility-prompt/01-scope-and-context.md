# Scope and context

Ты работаешь в репозитории:
/Users/e.nekrasov/Projects/harness/session-guard

Задача: сделать smoke-сценарии применимыми к двум поддерживаемым host-контрактам
OpenCode — V1 и V2 — через ОДИН общий интерфейс `SmokeHost` и один общий runner.
Поддержка каких-либо других, неизвестных или будущих версий OpenCode НЕ входит в
задачу.

Не проектируй универсальный framework для произвольных версий. Не добавляй
абстракции для будущих host-ов, если они не нужны для одновременной работы V1 и
V2. Целевой результат — один интерфейс, один сценарный API, общие сценарии и
общая модель результатов. Различия V1/V2 скрыты внутри transport/configuration
strategies единого фасада.

## Контекст

Каталог `smoke/` — самостоятельная интеграционная suite. Она запускает настоящий
`opencode serve` во временном проекте, загружает собранный plugin и управляет host
через живую модель.

Основные файлы:

- `smoke/src/harness.ts` — lifecycle OpenCode host, изоляция, конфигурация, запуск процесса;
- `smoke/src/scenario-kit.ts` — текущий V1 transport/scenario runner;
- `smoke/src/v2-client.ts` — текущий V2 generated client и forms;
- `smoke/src/v2-scenario-kit.ts` — текущий V2 scenario runner;
- `smoke/src/run.ts` — CLI runner;
- `smoke/src/scenarios/*.ts` — сценарии;
- `smoke/test/*.test.ts` — unit-тесты smoke-suite;
- `smoke/README.md` — документация suite;
- `smoke/AGENTS.md` — обязательные инструкции для smoke-проекта;
- корневые `AGENTS.md`, `docs/plugin-architecture.md` и `CONTRIBUTING.md` — если
  затрагивается production plugin.

Перед работой прочитай:

1. корневой `AGENTS.md`;
2. `smoke/AGENTS.md`;
3. `smoke/README.md`;
4. релевантные файлы из списка выше;
5. текущие тесты suite.

Основной scope — `smoke/`, его тесты и README. Production plugin в `src/` можно
изменять только после read-only анализа, если доказано, что smoke-only решение
дублирует plugin logic, ломает semantics или не может выразить корректный общий
V1/V2 contract.

### Граница импортов smoke

`smoke/` остаётся самостоятельным внешним потребителем plugin. Smoke не должен
импортировать исходники или типы production plugin из `src/`, `dist/` или его
внутренних модулей, включая `import type`. Не добавляй обратную compile-time
зависимость `smoke -> plugin`.

Smoke может читать поставляемые fixture-ы из корня и проверять runtime state,
tool output и файлы, которые создаёт настоящий host/plugin. Это runtime boundary,
а не основание для импорта внутренних TypeScript-контрактов.

Если для общего V1/V2 smoke contract нужны типы, объяви локальные normalized types
внутри `smoke/` и переиспользуй их между обеими transport strategies. Для
workflow state используй локальные типы поверх `unknown` и runtime narrowing,
поскольку type assertion сам по себе не проверяет JSON во время выполнения.

Создание отдельного стабильного public contract package допустимо только как
отдельное явно принятое архитектурное решение. Оно не входит в эту задачу.

Перед первым изменением составь список несовпадений и классифицируй каждое:

1. `transport-only` — исправляется внутри V1/V2 transport strategy;
2. `orchestration-only` — исправляется в `SmokeHost` facade или runner;
3. `plugin-contract-mismatch` — может потребовать минимальной правки plugin;
4. `domain-behavior-mismatch` — нельзя исправлять механической нормализацией.

По умолчанию исправляй проблему на самом внешнем слое, где сохраняется семантика.
Правка plugin разрешена только если одновременно выполнены условия:

- указан конкретный contract mismatch;
- показано, почему smoke-only решение создаёт дублирование, хрупкость или ложный
  parity;
- изменение минимально и не меняет публичную семантику без необходимости;
- сохранена обратная совместимость существующих V1/V2 tools и workflows;
- добавлены или обновлены plugin tests;
- в итоговом отчёте перечислены изменённые plugin-файлы, контракты и риски.

Не меняй plugin только ради удобства типов или чтобы скрыть реальную разницу
OpenCode transport API.

## Стратегия миграции

Не переписывай текущие V1/V2 файлы и runner-ы массово. Используй staged migration
с временным compatibility bridge:

1. сохрани текущую реализацию и её тесты как baseline;
2. создай общий слой рядом с текущим кодом;
3. используй существующие V1/V2 transport helpers там, где это безопасно;
4. переводи один простой сценарий и проверяй его через оба host kinds;
5. затем переводи остальные сценарии небольшими группами;
6. после каждой группы проверяй parity и legacy baseline;
7. удали старые runner-ы, registry и дублирующие типы только после полной миграции.

Первый этап ограничен вертикальным срезом: `plugin-loads`, `create`, общий
`SmokeHost` facade, V1/V2 transport strategies, один runner, один canonical
registry, одинаковые unit assertions и live smoke через оба host kinds.

Не включай в первый этап consent, task, negative, commit, subagent, CI/CD и полный
retry redesign. Эти части мигрируй только после успешного вертикального среза.

Новая реализация не должна оставаться второй постоянной smoke-suite. Нельзя
завершать задачу с двумя независимыми источниками истины.

Не создавай копии вида `scenario-kit-new.ts`, `v2-scenario-kit-new.ts` или
`run-new.ts`. Предпочтительно создать новые границы вроде:

```text
smoke/src/host/types.ts
smoke/src/host/transport.ts
smoke/src/host/facade.ts
smoke/src/runner.ts
```

Имена и структура могут отличаться, но переходный слой должен постепенно заменить
старые границы, а не сосуществовать с ними как альтернативная архитектура.

## Граница поддержки

Поддерживаемые варианты ровно такие:

1. `HOST_SMOKE_OPENCODE_VERSION=v1` — текущий Legacy HTTP API;
2. `HOST_SMOKE_OPENCODE_VERSION=v2` — текущий `@opencode/client` API.

Не добавляй:

- поддержку V3 или иных версий;
- автоматическое распознавание неизвестных версий;
- fallback с явно выбранного V1 на V2 или наоборот;
- capability framework для произвольных будущих адаптеров;
- обещание совместимости с любой версией OpenCode.

Если явно выбран V1 или V2, единый `SmokeHost` должен использовать соответствующую
внутреннюю transport strategy.
Если host выбранного варианта не отвечает ожидаемому контракту, завершай запуск с
понятной ошибкой этого адаптера. Не подменяй выбранный host другим вариантом.
