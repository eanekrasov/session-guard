# Scenario contract and canonical registry

### 3. Единое описание сценария и один runner

Сделай scenario definition общей для V1 и V2:

```ts
interface ScenarioDefinition {
  id: string;
  title: string;
  migrationState: 'migrated' | 'pending';
  profile?: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
  git?: boolean;
  agent?: string;
  steps: ScenarioStep[];
}
```

`migrationState` является частью authoritative canonical registry. Сценарий
`pending` обязан сохранять canonical metadata, но не обязан иметь runnable steps:
его registry entry используется для parity report и получает
`ParityReportEntry.parity: 'not-run'` с причиной `pending-migration`. Сценарий
`migrated` обязан иметь runnable steps и должен запускаться через обе strategies.

Допустим другой дизайн, но один и тот же сценарий должен уметь запускаться обоими
единым `SmokeHost`.

Обязательно обеспечить V2 теми же настройками, которые уже доступны V1:

- `profile`;
- `env`;
- дополнительные `files`;
- общие smoke-файлы, включая `plan.md`;
- `scripts/commit-task.ts`, если сценарий его использует;
- выбор agent.

Не дублируй конфигурацию V1 и V2 вручную в каждом сценарии.

Эти поля являются canonical scenario metadata. Один registry передаёт их в
`startHost()` для обоих host kinds. Syntax plugin config и auth могут различаться,
но итоговая test environment должна быть эквивалентной. Добавь runtime-тест,
проверяющий фактические profile/env/files/git/agent inputs каждой strategy.

### 4. Общий запуск host с единым фасадом

`startHost()` должен принимать единый `HostOptions`, а внутри использовать
V1/V2-специфичные операции только там, где это действительно необходимо:

- plugin config;
- auth/provider setup;
- startup arguments;
- agent setup;
- transport connection.

Проверь для обеих внутренних strategies:

- выбор profile;
- копирование profile agents;
- запись scenario files;
- передача env;
- plugin config;
- auth setup;
- git initialization;
- cleanup.

### 5. Единый фасад с двумя внутренними transport strategies

Не выставляй два адаптера как разные интерфейсы для сценариев. Введи один фасад,
который выбирает ровно одну из двух внутренних transport strategies:

```ts
type HostKind = 'v1' | 'v2';

interface HostTransport {
  createSession(title: string): Promise<SmokeSession>;
  prompt(session: SmokeSession, input: PromptInput): Promise<PromptResult>;
  readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>;
  listInteractions(session: SmokeSession): Promise<NormalizedInteraction[]>;
  replyToInteraction(
    session: SmokeSession,
    interaction: NormalizedInteraction,
    answer: FormAnswer
  ): Promise<void>;
  waitForTurn(session: SmokeSession): Promise<TurnStatus>;
  removeSession(session: SmokeSession): Promise<void>;
}
```

Возможная структура:

```text
SmokeHostFacade
  └── HostTransport
        ├── LegacyHttpTransport      # V1
        └── SessionClientTransport    # V2
```

Единый фасад должен скрывать:

````

- transport;
- config writer;
- auth behavior;
- agent selection;
- forms/questions;
- message normalization;
- session lifecycle.

Общие сценарии, assertions, operator policy и общий runner не должны делать
ветвление по версии. Допустимое ветвление — только в одном месте выбора фасадом
внутренней V1/V2 strategy и в host bootstrap/configuration code.

Не смешивай OpenCode host contract и production plugin contract. Разницу между
`/question` и forms, agent switching, auth и plugin loading исправляй в
`SmokeHost` facade или его внутренних transport/configuration strategies. Разницу
в semantics или result shape самого plugin можно исправлять в production plugin
только после доказательства `plugin-contract-mismatch` по правилам
`01-scope-and-context.md`.

### 6. Один общий runner

Объедини V1/V2 runner-логику в один общий runner, работающий только с `SmokeHost`
и нормализованными типами.

Общий runner должен:

- создавать host session;
- выполнять шаги;
- читать durable workflow state;
- применять assertions;
- выполнять cleanup через `finally`;
- возвращать единый результат;
- сохранять evidence;
- не выдавать PASS только потому, что prompt завершился без ошибки.

Не создавай два публичных runner-а для V1 и V2. Внутренние transport strategies
могут отличаться, но сценарный runner должен быть один.

Для первого вертикального среза facade должен предоставлять минимальный контракт:

```ts
interface SmokeHost {
  readonly kind: 'v1' | 'v2';
  createSession(title: string): Promise<SmokeSession>;
  runPrompt(session: SmokeSession, input: PromptInput): Promise<PromptResult>;
  readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>;
  closeSession(session: SmokeSession): Promise<void>;
}
````

Нормализованный результат prompt должен связывать turn с observable evidence:

```ts
interface PromptResult {
  turn: NormalizedTurn;
  workflowState: SmokeWorkflowState | null;
  pluginEvidence: PluginObservation;
}

interface PluginObservation {
  loaded: boolean;
  observedPluginTools: string[];
  invokedTools: NormalizedToolCall[];
  hostOperation: 'real-host' | 'unknown';
  result: 'success' | 'error' | 'unknown';
}
```

`plugin-loads` обязан проверять `turn`, `pluginEvidence.loaded`, ожидаемый
наблюдавшийся plugin tool, `hostOperation: 'real-host'` и структурированный result.
Отсутствие ошибки prompt само по себе не является доказательством загрузки plugin.

`SmokeWorkflowState` — локальный normalized smoke-type, а не тип production plugin.
Минимальный контракт должен позволять runner-у доказать outcome операции:

```ts
interface SmokeWorkflowState {
  sessionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  operationId?: string;
  operationStatus?: 'pending' | 'completed' | 'failed' | 'unknown';
  durableMutation?: 'none' | 'applied' | 'unknown';
}
```

Обе transport strategies обязаны реализовать
`readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>`.
Если strategy не может прочитать состояние или подтвердить outcome mutating
операции, facade возвращает `null` либо state с `durableMutation: 'unknown'`, а
runner применяет `blocked` с `indeterminate_mutation`; он не обращается к legacy
`Host`, filesystem или transport API напрямую.

Polling forms/questions, agent selection, timeout handling и cleanup должны быть
внутренними деталями `runPrompt()`/facade. Не выставляй transport-level операции
сценариям без доказанной необходимости.

Граница ответственности должна быть явной:

- `startHost(options)` создаёт изолированный проект, записывает canonical metadata
  (`profile`, `env`, `files`, `git`), готовит plugin config/auth и запускает процесс;
- `SmokeHost` владеет session lifecycle, prompt orchestration, operator policy,
  timeout normalization и host-specific transport;
- общий runner владеет порядком scenario steps, durable workflow state, assertions,
  retry policy и сбором `ScenarioResult`;
- operator policy является внутренней частью `SmokeHost`/prompt coordinator;
- durable state и host logs являются evidence sources, но не transport API.

`HostTransport` — внутренний seam фасада, а не второй публичный интерфейс сценариев.
Runner не должен вызывать transport-level operations или V1/V2 API напрямую.
Чтение durable workflow state выполняется только через
`SmokeHost.readWorkflowState()`. Runner не должен обращаться к `Host`, filesystem
или legacy helper напрямую.

Общий facade/runner можно вводить рядом с текущими V1/V2 runner-ами как временный
compatibility bridge. Старые runner-ы в этот период являются baseline для сравнения,
но не должны получать новые сценарии или новые semantics. После миграции последнего
сценария bridge и старые runner-ы должны быть удалены, если только в итоговом
отчёте явно не доказано, что конкретный helper нужен общей реализации.

### 7. Один canonical scenario registry

После реализации должен существовать один canonical registry сценариев. Runner
выбирает `hostKind` (`v1` или `v2`), а не отдельный список сценариев для каждой
версии.

Не оставляй два независимых вручную поддерживаемых массива вроде `scenarios` и
`v2Scenarios`. Если для обратной совместимости нужны два представления, они должны
быть производными от одного источника, а не содержать разные наборы сценариев.

Каждый текущий сценарий обязан быть представлен в canonical registry. Нельзя
молча исключить сценарий из V2 только потому, что текущий V2 transport ещё не
поддерживает нужную операцию: сначала проверь и исправь общий контракт и
соответствующую transport strategy.

Registry создаётся сразу для всех текущих V1 IDs, но migration state отделён от
runnable status. На первом этапе только `plugin-loads` и `create` имеют
`migrationState: 'migrated'` и запускаются через оба host kinds. Остальные имеют
`migrationState: 'pending'`, получают `ParityReportEntry.parity: 'not-run'` с
`notRunReason: 'pending-migration'` в parity report и не могут быть
объявлены `blocked`, `limited parity` или behavioral parity.

`no-session` явно относится к следующему этапу и не входит в acceptance первого
этапа.

Временный compatibility bridge может запускать старый baseline для сравнения, но
не меняет canonical registry и не является authoritative runner-ом для
мигрированных сценариев.

Canonical IDs текущего набора — существующие V1 IDs: `plugin-loads`, `create`,
`no-session`, `git-block`, `task-control`, `commit-gate`, `plan-consent`,
`commit-cwd`, `commit-mismatch`, `cicd-full-cycle`, `verify-loop`. Старые V2 IDs
`v2-workflow-create`, `v2-workflow-consent`, `v2-workflow-tasks` не являются
отдельными сценариями и не должны оставаться во втором registry. Перенеси их
проверяемую семантику в соответствующие canonical scenarios; provenance старого
V2 coverage можно сохранить в отчёте.

Приведённые выше TypeScript-типы являются иллюстративными. Перед созданием новых
типов сначала найди существующие типы в `smoke/`; не оставляй в реализации ссылки
на несуществующие `SmokeSession`, `PromptResult`, `TurnStatus`,
`NormalizedInteraction` или `FormAnswer`.
