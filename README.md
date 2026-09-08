# opencode-state-machine

State machine плагин для [OpenCode](https://opencode.ai/) — управляет жизненным циклом
workflow-сессий: фазы, переходы, консент (одобрение), мутации, gates, инварианты и верификация.

## Документация

Три входа, по тому, что вы собираетесь делать.

### Работаю под управлением плагина

[Как это устроено](docs/architecture-overview.md) — что происходит с сессией,
кто и почему вас останавливает, где смотреть состояние. Короткая версия для
первого запуска — [руководство пользователя](docs/user-guide.md).

### Пишу свой профиль

[Как написать свой профиль](docs/profile-authoring.md) — полное руководство:
структура профиля, схема целиком (стадии, переходы, `actions:`, циклы, guard-ы,
области записи), наследование, готовые примеры и способ проверки.

### Правлю сам плагин

[Устройство кода](docs/plugin-architecture.md) — слои, направление
зависимостей, путь одного вызова инструмента, чем что проверяется.

### Отдельные разделы

- [установка и запуск](docs/usage.md);
- [настройка](docs/configuration.md);
- [справочник workflow schema](docs/schema-reference.md) — сжатая выжимка по
  полям, когда полное руководство уже прочитано;
- [примеры schema](docs/schema-examples.md);
- [guide по написанию schema](docs/schema-writing-guide.md);
- [статус возможностей](docs/feature-status.md);
- [диагностика](docs/troubleshooting.md);
- [FAQ](docs/faq.md).

Ниже README содержит технические подробности для случаев, когда они нужны при
диагностике или сопровождении установки.

Плагин регистрирует хуки SDK OpenCode, перехватывая вызовы инструментов (`Bash`, `Write`,
`Question`, `Task`) и управляя состоянием сессии на основе декларативных профилей и схем.

---

## Архитектура

### Трёхслойная модель

Код организован в три слоя, каждый со своей ответственностью:

```
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 1: Plugin Entry + Hooks Orchestrator                      │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐  │
│  │ StateMachinePlugin   │  │ StateMachineRuntime               │  │
│  │ (src/index.ts)       │─▶│ (src/app/runtime.ts)              │  │
│  │                      │  │                                  │  │
│  │ Создаёт runtime dir,  │  │ Регистрирует хуки OpenCode SDK:  │  │
│  │ env init, делегирует │  │ - config() — sm-* команды + агент │  │
│  │ createRuntime(ctx)   │  │ - tool() — workflow-create/list    │  │
│  └──────────────────────┘  │ - chat.message() — log state      │  │
│                            │ - tool.execute.before() — guard   │  │
│                            │ - tool.execute.after() — capture  │  │
│                            │ - event() — error recovery        │  │
│                            │ - system.transform() — inject      │  │
│                            │   workflow context в system prompt │  │
│                            │ - session.compacting() — state     │  │
│                            │   preservation при compaction     │  │
│                            │ - dispose() — cleanup             │  │
│                            └──────────────────────────────────┘  │
│                                                                  │
│  Hook Handlers (inline в runtime.ts):                            │
│  ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐ │
│  │GuardrailHandler │ │ ConsentHandler │ │   CommitPermit       │ │
│  │ validateInput   │ │ parseConsent   │ │   block git commit   │ │
│  │ sanitizeOutput  │ │ classifyAnswer │ │   issue deliveryPermit││
│  └────────────────┘ │ verifyEvidence  │ └──────────────────────┘ │
│                     └────────────────┘                          │
│  ┌────────────────────┐ ┌────────────────────┐                  │
│  │  MutationHandler   │ │  TransitionHandler  │                  │
│  │  begin/finish      │ │  tryApplyTransitions │                  │
│  │  file invariants   │ │  после каждого шага  │                  │
│  └────────────────────┘ └────────────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 2: Orchestrators + Business Logic                        │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────┐         │
│  │ MutationOrchestrator  │  │  ConsentOrchestrator      │         │
│  │ (src/app/...)        │  │  (src/app/...)            │         │
│  │                      │  │                          │         │
│  │ - resolveEngine()    │  │ - before(): парсинг       │         │
│  │ - beginMutation()    │  │   consent-request тега,   │         │
│  │ - finishMutation()   │  │   чтение плана, evidence  │         │
│  │ - processScopeAnd-   │  │ - after(): классификация  │         │
│  │   Invariants()       │  │   ответа, ре-верификация  │         │
│  │ - applyTransitions() │  │ - verifyPlanEvidence-     │         │
│  │ - clearOnError()     │  │   AtDecision()            │         │
│  │ - releaseInterrupted-│  └──────────────────────────┘         │
│  │   Lock() [P1-014]    │                                      │
│  └──────────────────────┘                                      │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────┐         │
│  │ InvariantsEngine     │  │  GuardrailsEngine         │         │
│  │ (src/app/invariants) │  │  (src/app/guardrails.ts)  │         │
│  │                      │  │                          │         │
│  │ - getAllProfile-     │  │ - GUARDS[]: 7 категорий  │         │
│  │   Invariants()       │  │   (PROMPT_INJECTION,     │         │
│  │ - validateFiles()    │  │    ROLE_OVERRIDE, ...)    │         │
│  │ - validateFiles-     │  │ - validateUserInput()    │         │
│  │   ForProfile()       │  │ - sanitizeToolOutput()   │         │
│  └──────────────────────┘  └──────────────────────────┘         │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 3: Domain + Infrastructure                               │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────┐         │
│  │ StateMachineEngine    │  │ GuardEvaluator            │         │
│  │ (src/domain/engine.ts)│  │ (src/guard-evaluator.ts)  │         │
│  │                      │  │                          │         │
│  │ - checkTransition()  │  │ - new Function() sandbox  │         │
│  │ - canPerformAction() │  │ - timeout 500ms           │         │
│  │ - tryApply-          │  │ - context: approved(),    │         │
│  │   Transitions()      │  │   isExhausted(),          │         │
│  │ - evaluateGuard()    │  │   hasPendingTasks()       │         │
│  └──────────────────────┘  └──────────────────────────┘         │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────┐         │
│  │ ProfileResolver       │  │ SchemaLoader              │         │
│  │ (src/profile-        │  │ (src/schema-loader.ts)    │         │
│  │  resolver.ts)        │  │                          │         │
│  │                      │  │ - loadSchemaFile()        │         │
│  │ - resolve()          │  │ - mergeSchemas() deep     │         │
│  │ - resolveExtends()   │  │ - loadSchemaFromPath()    │         │
│  │ - resolveSchemas()   │  │                          │         │
│  └──────────────────────┘  └──────────────────────────┘         │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────┐         │
│  │ WorkflowStore         │  │ SessionQueue              │         │
│  │ (src/session/        │  │ (src/app/session-         │         │
│  │  session-store.ts)   │  │  queue.ts)                │         │
│  │                      │  │                          │         │
│  │ - save() atomic write│  │ - enqueue() serialised    │         │
│  │ - load() zod validate│  │ - resolveRoot() via       │         │
│  │ - delete()           │  │   parentCache             │         │
│  │ - list()             │  │ - withSession() helper    │         │
│  └──────────────────────┘  └──────────────────────────┘         │
└──────────────────────────────────────────────────────────────────┘
```

### Схема потоков данных

```
OpenCode Tool Call
       │
       ▼
┌──────────────────────────────────────────────────┐
│ StateMachineRuntime.handleToolBefore()            │
│                                                   │
│  1. GuardrailHandler.validateUserInput(args)      │
│     → блокировка prompt injection, role override  │
│                                                   │
│  2. ConsentHandler (только Question tool)         │
│     → парсинг <consent-request> тега              │
│     → вычисление SHA-256 evidence плана           │
│     → проверка HARNESS_AUTO_APPROVE               │
│                                                   │
│  3. TaskHandler (только task tool)                │
│     → session.activeOperations[callId] = { agent }│
│                                                   │
│  4. CommitPermit (только Bash)                    │
│     → hasForbiddenGitSubcommand() → block         │
│     → isCommitTaskCommand() → deliveryPermit       │
│                                                   │
│  5. MutationHandler (только Bash/Write)           │
│     → MutationOrchestrator.beginMutation()        │
│     → releaseInterruptedLock() [P1-014]           │
│     → beginMutation() domain                      │
└──────────────────────────────────────────────────┘
       │
       ▼  [Tool executes: Bash/Write/Question/Task/...]
       │
       ▼
┌──────────────────────────────────────────────────┐
│ StateMachineRuntime.handleToolAfter()             │
│                                                   │
│  1. GuardrailHandler.sanitizeToolOutput()         │
│     → замена блок-паттернов на [BLOCKED:RULE]     │
│                                                   │
│  2. WorkflowResult                               │
│     → парсинг <workflow-result> тегов             │
│     → session.verifications.push()                │
│                                                   │
│  3. FileHandler (только edit/write/apply_patch)   │
│     → validateFilesForProfile()                   │
│     → аппенд нарушений в output                   │
│                                                   │
│  4. CommitPermit (только Bash)                   │
│     → git diff-tree → deliveryReceipt             │
│     → сверка committed с expectedFiles            │
│                                                   │
│  5. ConsentAnswer (только Question)              │
│     → classifyConsentAnswer() → grant/decline    │
│     → verifyPlanEvidenceAtDecision()              │
│     → applyTransitions() после approve            │
│                                                   │
│  6. MutationHandler (только Bash/Write)          │
│     → MutationOrchestrator.finishMutation()       │
│     → processScopeAndInvariants()                 │
│     → computeChangeScope() [git status]           │
│     → validateFiles() [invariants]                │
│     → finishMutation() domain → gate update       │
│     → tryApplyTransitions()                       │
│     → post-factum transition validation           │
│                                                   │
│  7. TransitionHandler (всегда)                   │
│     → tryApplyTransitions(session)                │
└──────────────────────────────────────────────────┘
```

### Роли слоёв

| Слой                   | Компоненты                                                                                                           | Отвечает за                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Plugin Layer**       | `index.ts`, `runtime.ts`                                                                                             | Инициализация, регистрация хуков SDK, оркестрация вызовов, DI                                                |
| **Orchestrator Layer** | `mutation-orchestrator.ts`, `consent-orchestrator.ts`, `invariants.ts`, `guardrails.ts`                              | Бизнес-логика — жизненный цикл мутации/консента/инвариантов/безопасности, точка координации доменных функций |
| **Domain Layer**       | `engine.ts`, `session-store.ts`, `session-queue.ts`, `guard-evaluator.ts`, `profile-resolver.ts`, `schema-loader.ts` | Чистая логика — переходы фаз, guard-выражения, персистентность, сериализация, профили                        |

### Внешние сервисы (опционально)

```
┌──────────────────────────────────────────────────────┐
│  Dashboard Server (отдельный процесс)                 │
│  src/dashboard/dashboard-server.ts                    │
│                                                      │
│  HTTP + SSE на порту 3456                            │
│  - GET /api/schema — контракт стейт-машины            │
│  - GET /api/session/:id — сессия + фаза               │
│  - GET /api/session/:id/timeline — события            │
│  - GET /api/session/:id/invariants — нарушения        │
│  - GET /api/metrics — агрегированные метрики          │
│  - GET /events — SSE с инкрементальными обновлениями  │
│  - fs.watch + polling 500ms → diff → push            │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  Task Provider (опционально, плагин для bd/gh/jira)  │
│  src/app/provider.ts + beads-bridge.ts                │
│                                                      │
│  TaskProvider интерфейс:                              │
│  - getTask(id), getReadyTasks(), postComment()        │
│  - InMemoryProvider (тесты)                           │
│  - createCliProvider() via Bun.spawn                  │
│  - Beads Bridge: обёртка над bd CLI с кешем 30s       │
└──────────────────────────────────────────────────────┘

## Сессия (WorkflowSession)

Zod-валидируемый JSON, сохраняемый на диск. Каждое поле сессии — бизнес-сущность.

### Схема (src/session/session-schema.ts)

```

WorkflowSession (Zod-схема, src/session/session-schema.ts)
├── sessionId — уникальный ID сессии
├── profileId — привязанный профиль (base, android, harness)
├── schemaId — какую из схем профиля выполняет сессия
├── schemaVersion — версия формата (=2)
├── revision — монотонный счётчик (инкремент на каждом save)
├── title — заголовок сессии
│
├── currentStage — стадия; имена задаёт схема профиля, а не ядро
├── gates — Gate[]: [{id, status, label?, resolvedAt?}] — только сессионные
│ гейты; гейты задач живут на прогонах
├── checks — вердикт ядра о последнем ходе ВНЕ цикла (см. ниже)
├── outcome — чем и почему кончился workflow; пишется при входе в конец
│
├── approvals — Approval[]: [{type, callId, status, grantedAt?, evidence?}]
│ тип — имя согласия из схемы: plan, deploy, любое
├── refs — Record<string, string> — документ под именем своего согласия
├── consentedCallIDs — string[] (защита от повторной обработки)
│
├── tasks — Record<listKey, MutationTask[]> — списки по имени цикла
├── loopRuns — Record<runId, LoopRun> — прогон задачи: стадия, гейты, checks
├── activeTaskContexts — открытые задачи для показа
├── activeOperations — Record<callId, ActiveOperation> — открытые ходы;
│ на стадии с гейтами их несколько сразу
├── pendingDecisions — решения, переданные оператору при исчерпании бюджета
├── retryBudgets — Record<string, {attempts, maximum}>
│
├── deliveryPermit — DeliveryPermit | null (preCommitHead, expectedFiles)
├── deliveryReceipt — SHA коммита | null
│
├── verifications — Verification[]: [{stage, status: confirmed|rejected}]
├── changedFiles — string[] — что накопила работа, сверено с HEAD
├── invariantViolations — ValidationRecord[]
├── processedResultCallIDs — string[] (защита от повторного вердикта)
└── updatedAt — ISO timestamp

````

### Гейты

Сессия не несёт собственного списка гейтов. Гейт появляется в ней тогда, когда
по нему приходит первый вердикт (`setGateStatus`), а гейт, о котором никто не
говорил, отсутствует — и любой guard читает отсутствие как «не passed».

Список объявляет профиль, а не код:

```yaml
# profiles/base/base.yaml
gates:
  - id: review
    label: Code review
  - id: qa
    label: QA verification
```

Гейта `invariants` в этом списке нет намеренно. Вердикт ядра о ходе перестал
быть гейтом: гейты пишет агент через `<workflow-result>` и любой объявленный
стадией гейт может выставить себе сам, а этот вердикт ядро выносит, посмотрев
на диск. Он живёт отдельным полем — `task.checks` на прогоне задачи внутри
цикла и `session.checks` на сессии вне его.

Компилятор (`src/schema/compile-workflow.ts`) сверяет `gates:` каждой стадии с
этим объявлением, поэтому опечатка в имени гейта — ошибка компиляции, а не
стадия, которая ждёт вечно. Профиль, не объявивший гейтов, сверять не с чем:
проверка пропускается, а не выдумывает список за него.

### SessionStore — файловое I/O (src/session/session-store.ts)

- Сессии хранятся как `{storeDir}/{encodeURIComponent(sessionId)}.json`
- `save()` — атомарная запись через tmp + rename, per-session цепочка блокировок
- `load()` — чтение + Zod-валидация с `.passthrough()` для неизвестных полей
- `list()` — сканирование директории, декодирование URI (подкаталог `archive/`
  в перечисление не попадает: перечисляются только файлы)
- `archive()` — перенос законченной сессии в `{storeDir}/archive/`,
  `loadArchived()` — чтение оттуда
- События: `onSave` (Set) + `onSessionSaved` (глобальный Set из session-events.ts)

**Архив.** Дойдя до терминальной стадии — объявленной в схеме и не имеющей
исходящих рёбер, — сессия уезжает из рантайма в `archive/` и перестаёт чем-либо
управлять: `load()` её не находит, а «сессии нет» этот проект выражает ровно
одним способом. Перенос, а не удаление: расписка о доставке, гейты, вердикты и
одобрения — продукт работы. Архив читают TUI, dashboard и host-smoke.

**parentCache**: кеш sessionId → rootSessionId, заполняемый при каждом save.
Используется SessionQueue для разрешения корневой сессии.

## Фазы и Transition Engine

### Декларативные переходы (profiles/state-machine.yaml)

```yaml
transitions:
  - from: planning
    to: tasks_ready
    guard: 'session.refs.plan != null'
    consent: plan

  - from: tasks_ready
    to: code
    guard: 'hasPendingTasks()'

  - from: code
    to: review
    guard: "session.gates.invariants == 'passed'"

  - from: qa
    to: code
    guard: "session.gates.qa == 'failed' && !isExhausted('cycles')"
    effects:
      - bumpRetry: cycles
        maxAttempts: 5

  - from: commit
    to: done
    guard: 'session.deliveryReceipt != null'
```

**Типы переходов (TransitionDef в schema/types.ts):**

```typescript
interface TransitionDef {
  from: string; // Текущая фаза
  to: string; // Целевая фаза
  guard?: string | null; // JS-выражение (опционально)
  effects?: TransitionEffect[]; // Побочные эффекты
  consent?: string | ConsentOnTransition; // Требует одобрения
}

interface TransitionEffect {
  bumpRetry?: string; // Ключ retry budget для инкремента
  maxAttempts?: number; // Лимит попыток
  approve?: string; // Тип approval при переходе
}
```

### StateMachineEngine (src/domain/engine.ts)

**checkTransition(from, to, transitions, session?, evaluateGuard?): TransitionCheck**

```typescript
interface TransitionCheck {
  allowed: boolean; // Разрешён ли переход
  reason?: string; // Причина запрета
  to?: string; // Целевая фаза (из найденного перехода)
  guard?: string | null; // Guard-выражение (для отладки)
}
```

Логика:

1. Найти `TransitionDef`, где `from` и `to` совпадают
2. Если есть guard — вычислить через `GuardEvaluator`
3. Если guard вернул false — `{ allowed: false, reason: "..." }`

**admitAction(entries, request, evaluateGuard): { allowed, reason }**

Допуск действия на стадии — `src/domain/action-admission.ts`. Стадия объявляет
`actions:`, и это исчерпывающий список: не совпало ничего — нельзя.

```yaml
code:
  actions:
    - action: edit
      paths: ['**']
      guard: "session.approved('plan')"
    - action: bash
      commands: ['git status', 'git diff.*']
      guard: "session.approved('plan')"
```

Записи читаются по порядку; побеждает первая, у которой совпал дискриминатор
(`paths` для `edit`, `commands` для `bash`) и истинен guard. `delivers: true`
на записи `bash` помечает доставку коммита.

Раньше эту ось нёс плоский `actionGuards` — одно выражение на весь граф, без
возможности сказать «здесь можно, а на planning нельзя».

**tryApplyTransitions(session): TransitionCheck & { applied?: boolean }**

Сканирует ВСЕ переходы из `session.currentStage`, для каждого:

1. Если есть `consent` — проверяет `session.approved(consentType)`; если не approved — skip
2. Если guard проходит — применяет переход:
   - `session.currentStage = transition.to`
   - Выполняет effects (bumpRetry, approve)
3. Если ни один не подошёл — `{ applied: false }`

Этот метод вызывается **после каждого инструмента** (через `transitionAfter`)
и **после approve плана** (в `ConsentOrchestrator`).

### GuardEvaluator (src/guard-evaluator.ts)

**Песочница для JS-выражений:**

- `new Function(...keys, ...values, 'return (expression);')`
- Нет доступа к глобальному скоупу, require, import
- Таймаут 500ms (`AbortSignal.timeout`)

**Доступные функции в guard-выражениях:**

| Функция             | Описание                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| `approved(type)`    | `session.approvals.some(a => a.type === type && a.status === 'granted')` |
| `isExhausted(key)`  | `retryBudgets[key].attempts >= retryBudgets[key].maximum`                |
| `hasPendingTasks()` | `tasks.some(t => t.status === 'pending' \|\| t.status === 'running')`    |
| `session.*`         | Поля SessionFacts (profileId, revision, refs, gates, ...)                |

**SessionFacts (src/domain/session-facts.ts)** — проекция сессии для guard-выражений:

```typescript
interface SessionFacts {
  lastApproval: { type; callId; status; grantedAt?; evidence?; feedback? } | null;
  approvals: { type; status }[];
  tasks: { id; status }[];
  activeOperation: { id; startedAt; status; result? } | null;
  verifications: Verification[];
  gates: Record<string, GateStatus>;
  profileId: string;
  revision: number;
  deliveryReceipt: string | null;
  refs: Record<string, string>;
  retryBudgets: Record<string, RetryBudget>;
  verified(stage, status): boolean;
  isExhausted(budgetKey): boolean;
  approved(type): boolean;
}
```

## Session Events (src/session/session-events.ts)

Глобальный шина событий при сохранении сессии:

```typescript
export const onSessionSaved = new Set<() => void>();
```

Любой модуль может подписаться на сохранение любой сессии:

```typescript
import { onSessionSaved } from './session-events.ts';
onSessionSaved.add(() => {
  /* реакция на сохранение */
});
```

Вызывается в `WorkflowStore.save()` после успешной записи на диск.
Используется для внешних наблюдателей (например, дашборд или метрики).

**WorkflowStore.onSave** — аналогичный per-instance Set на уровне store,
в отличие от глобального `onSessionSaved`.

## Session Helpers (src/session/helpers.ts)

Утилиты для работы с сессией — gate management, retry budgets, validation records:

```typescript
// Gate
function getGate(session, gateId: string): Gate | undefined;
function setGateStatus(session, gateId, status: GateStatus, options?: SetGateStatusOptions): void;
// status = passed/failed → gate.resolvedAt = now
// status = failed + options.bumpRetry → bumpRetry(session, key)

// Retry budget
function bumpRetry(session, budgetKey: string): void; // attempts++
function isExhausted(session, budgetKey: string): boolean; // attempts >= maximum
function resetRetry(session, budgetKey: string): void; // сброс attempts → 0

// Validation records
function setInvariantViolations(session, violations): void; // присваивание evidenceId
```

## SessionQueue (src/app/session-queue.ts)

**Проблема:** конкурентные Bash/Write вызовы модифицируют одну сессию → race condition.

**Решение:** per-root-session serialized execution queue.

```typescript
class SessionQueue {
  // Сериализованное выполнение: action получает загруженную сессию,
  // save() вызывается автоматически после завершения
  enqueue<T>(
    sessionID: string,
    action: (session: WorkflowSession | null, rootSessionId: string) => Promise<T> | T
  ): Promise<T>;

  // Очистка всех очередей (dispose)
  clear(): void;
}
```

**Разрешение корневой сессии:**

- `parentCache` заполняется при каждом `store.save()`
- `resolveRoot(sessionID)` — walk по parentCache до корня, O(1) благодаря кешу
- Дочерние сессии (subtask) блокируются на той же очереди, что и родитель

**Обработка ошибок:** ошибка action'а логируется, но не блокирует последующие.

### withSession (src/app/session-queue.ts)

Вспомогательная функция для однократной загрузки + действия:

```typescript
async function withSession<T>(
  store: WorkflowStore,
  sessionID: string,
  action: (session: WorkflowSession) => Promise<T> | T
): Promise<T | null>;
```

## Runtime Types (src/app/runtime-types.ts)

Изолированные типы для SDK-зависимостей, чтобы тесты могли замокать `OpenCodeSessionClient`:

```typescript
interface OpenCodeSessionClient {
  messages(options: {
    path: { id: string };
    query?: { limit?: number; offset?: number };
  }): Promise<{ data: Array<{ id: string; parts: Array<{ type: string; status?: string }> }> }>;

  prompt(options: {
    path: { id: string };
    body: {
      content: string;
      parts: Array<{ type: string; noReply?: boolean; title?: string; text?: string }>;
    };
  }): Promise<{ data: unknown; error?: { message: string } }>;

  list(options?: {
    query?: { limit?: number };
  }): Promise<{ data: Array<{ id: string; title?: string }> }>;
}
```

## Data Flow (tool.execute lifecycle)

### BEFORE — handleToolBefore (runtime.ts:281)

```
Порядок вызова:

1. Guardrails (guardrailBefore)
   ├── validateUserInput(args)
   │   └── PROMT_INJECTION     (block)  — переопределение инструкций
   │   └── ROLE_OVERRIDE       (block)  — смена роли агента
   │   └── SYSTEM_EXTRACTION   (block)  — извлечение системного промпта
   │   └── CODE_INJECTION      (warn)   — eval, exec, rm -rf
   │   └── CONTEXT_CONFUSION   (warn)   — очистка контекста, спам
   │   └── INDIRECT_INJECTION  (warn)   — подставные системные сообщения
   │   └── DATA_EXFILTRATION   (warn)   — чтение ~/.ssh, env, git push --force
   │
   └── Если blocked → output.args.blocked = true

2. Consent (consentBefore)
   └── Tool != Question → skip
   └── Парсинг consent-request XML-тега в questionText
   └── ConsentOrchestrator.before():
       ├── parseConsentRequest() — шаблонный тег в question
       ├── evidenceOf(manifest) — сверка evidence
       ├── client.messages() — проверка контекста вопроса
       ├── readPlanFile() — чтение плана с диска
       ├── calculatePlanEvidence() — SHA-256 канонизированного плана
       ├── Queue.enqueue():
       │   ├── session.consentedCallIDs dedup
       │   ├── session.approvals += { type: <имя согласия>, callId, status: 'pending' }
       │   ├── session.refs[<имя>] = путь документа
       │   └── HARNESS_AUTO_APPROVE → одобряет то согласие, которое спросили
       └── finishMutation() — после auto-approve проверяет переход

3. Task start (handleTaskBefore)
   └── Tool != task или нет subagent_type/agent/type → skip
   └── Ход этого callID уже коррелирован → отказ
   └── session.activeOperations[callID] = { runId?, taskId?, agent, status }

3c. Stage actions (actionsBefore)
   └── Действующая стадия — вложенная при открытом прогоне, иначе внешняя
       ├── actions не объявлены → дефолт ядра: прямой git commit/push запрещён
       └── объявлены → admitAction(); список исчерпывающий

4. Commit Permit (commitBefore)
   └── Tool == Bash:
       └── isCommitDelivery() → выдача deliveryPermit
           ├── команды берутся из записи `delivers: true` действующей стадии;
           │   стадия молчит → зашитый isCommitTaskCommand как запасной вариант
           ├── getPreCommitHead() → git rev-parse HEAD
           └── session.deliveryPermit = { callID, preCommitHead, expectedFiles }
           (разрешён ли коммит вообще — это guard той же записи; в base это
            все задачи завершены И оба вердикта собраны)

5. Mutation guard (mutationBefore)
   └── Tool == Bash | Write:
       └── MutationOrchestrator.beginMutation():
           ├── resolveEngine(profileId) — lazy init + кеш
           ├── Queue.enqueue():
           │   ├── releaseInterruptedLock() — освобождение зависших мутаций
           │   ├── beginMutation() domain:
           │   │   ├── Проверка чужого хода (mutex, TTL 30мин)
           │   │   ├── resolveMutationRun() → run | ambiguous | none
           │   │   ├── session.activeOperations[callID] = новый
           │   │   └── session.verifications = []
           │   └── liveMutations.set(callID, { rootSessionId, stageBefore })
```

### AFTER — handleToolAfter (runtime.ts:382)

```
Порядок вызова:

1. Guardrails (guardrailAfter)
   └── sanitizeToolOutput() — замена block-паттернов на [BLOCKED:RULE]

2. Workflow result (handleWorkflowResult)
   └── parseWorkflowResult(output):
   │   └── Ищет последний <workflow-result>{JSON}</workflow-result>
   │   └── Валидация: stage ∈ {review, qa, verify_bug}, status ∈ {pass, fail}
   └── session.verifications.push({ stage, status, recordedAt })
   └── Совпадает activeOperation?.id == callID → clear

3. File tool invariants (handleFileToolAfter)
   └── Tool ∈ {edit, write, apply_patch}
   └── Извлечение filePath из args
   └── Проверка: файл внутри проекта, расширение ∈ {.kt, .ts, .json, .md}
   └── validateFilesForProfile() → результат аппендится в output.output

4. Commit verify (handleCommitTaskAfter) — для Bash
   └── deliveryPermit?.callID == callID
   └── git rev-parse HEAD != deliveryPermit.preCommitHead → commit сделан
   └── git diff-tree --name-only — сравнение committed с expectedFiles
   └── session.deliveryReceipt = currentHead
   └── session.deliveryPermit = null

5. Consent answer (handleQuestionAfter)
   └── Tool == Question
   └── parseConsentRequest(questionText) — ищем <consent-request> тег
   └── незакрытая запись одобрения с этим callId
   └── Извлечение ответов из metadata.answers + extractLabels()
   └── classifyConsentAnswer() → grant | decline
   └── verifyPlanEvidenceAtDecision() — сверка SHA-256 плана на диске
   └── grant: session.approvals.push({ type:'plan', status:'granted' })
   └── decline: approval.denied + session.revision++
   └── applyTransitions() — после approve пытается сменить фазу

6. Mutation finish (mutationAfter) — для Bash | Write
   └── MutationOrchestrator.finishMutation():
       ├── liveMutations.delete(callID)
       ├── Queue.enqueue():
       │   ├── processScopeAndInvariants():
       │   │   ├── computeChangeScope() — git status --porcelain + SHA-256 diff
       │   │   ├── session.changedFiles = sorted
       │   │   ├── validateFiles() — прогон инвариантов профиля
       │   │   └── finalPassed = !metadataFailed && !scopeError && нет errors
       │   ├── finishMutation() domain:
       │   │   ├── delete session.activeOperations[callID]
       │   │   └── run.checks = passed | failed  (вне цикла — session.checks)
       │   ├── tryApplyTransitions() — авто-переход после мутации
       │   └── Post-factum transition validation:
       │       └── Была ли смена фазы? Валидна ли она?

7. Transition (transitionAfter)
   └── tryApplyTransitions(session) — всегда, после любого инструмента
```

### System Prompt Injection (handleSystemTransform)

Перед каждым запросом к модели внедряет контекст сессии:

```
[workflow session: sess-abc123]
[workflow profile: android]
[workflow stage: code]
[workflow gates: invariants=passed]
[workflow approvals: plan]
[workflow mutation: call-xyz…]
[workflow tasks: 5 total, revision 3]
```

### Session Compacting (handleSessionCompacting)

При компактизации контекста сессии сохраняет критическое состояние:

```
Workflow session sess-abc123 (profile: android, revision: 3)
Tasks: 2/5 completed
Last completed task: task-002
Active task: task-003
Gates: invariants: passed, review: running, qa: pending
Approvals granted: plan
```

## Consent System (согласование планов)

Один формат — XML-тег. Прежний YAML-блок и его парсер удалены.

### XML-тег (src/app/consent.ts)

Агент вызывает `workflow-consent` tool, возвращающий XML-тег для встраивания в вопрос:

```xml
<consent-request
  schema="harness.consent/v1"
  revision="3"
  evidence="sha256:abc123..."
  grant="continue"
  decline="stop">
  {"schema":"harness.consent.evidence/v1","revision":3,"summary":"Add login page","files":[".opencode/plan/story-42/plan.md"]}
</consent-request>
```

**Имя согласия.** У манифеста есть необязательное поле `type` — то же имя,
которое схема пишет в `consent:` на переходе (`plan`, `deploy`, что угодно).
Отсутствует — значит `plan`. Имя входит в подпись манифеста, поэтому «согласие
на деплой» и «согласие на план» над одними файлами не дают одинаковую evidence,
и записывается оно в трёх местах: одобрение сессии, `session.refs.<имя>` и
ответ оператора. Раньше имя было захардкожено, и объявленное схемой согласие с
любым другим именем получить было невозможно — ребро закрывалось навсегда.

**Проверка evidence (verifyPlanEvidenceAtDecision):**

1. `canonicalizePlan(content)`: удаление BOM → \r\n → \n → обрезка трейлинговых пробелов → удаление трейлинг-новлайн
2. `calculateDocumentSetEvidence(documents)` — по всем файлам манифеста, а не только по первому
3. Сравнение с evidence незакрытой записи одобрения (`session.approvals`), найденной по `callId`

**Классификация ответа (classifyConsentAnswer):**

- Один ответ, начинающийся с `grant` → `{ kind: 'grant' }`
- Один ответ, начинающийся с `decline` → `{ kind: 'decline' }`
- Всё остальное → `{ kind: 'unrecognized' }`

### HARNESS_AUTO_APPROVE

При `HARNESS_AUTO_APPROVE=true` согласие одобряется автоматически, без показа
вопроса оператору — для прогонов без человека. Одобряется **то согласие,
которое спросили**, а не всегда план: иначе схема с двумя разными согласиями не
проезжает.

## Mutation Lifecycle

### Ход вне цикла задач

Прогон задачи для хода не обязателен. Стадия без `loop:` — обычная стадия, на
которой тоже работают, и `beginMutation` там заводит операцию без привязки к
прогону: `runId` и `taskId` отсутствуют честно, а не выдумываются. Машинерия та
же — свой baseline-кадр, дифф, проверка `writeScope`, инварианты, — и вердикт
ложится на сессию как `session.checks`.

Неоднозначность при этом остаётся отказом. `resolveMutationRun` различает три
исхода: прогон найден, прогонов или задач-кандидатов несколько, прогона нет
вовсе. Второй — отказ: выбрать за автора, к какому из двух прогонов отнести
правку, значит проверить её чужой областью записи. Кандидаты берутся только из
списка цикла текущей стадии, иначе в схеме с двумя последовательными циклами
ход первого синтезировал бы прогон по задаче второго.

### Lock-механизм

Мутации (Bash/Write/Subtask) защищены через `activeOperations` mutex:

1. **beginMutation** — заводит активную операцию, сбрасывает verifications
2. **finishMutation** — снимает операцию и записывает вердикт о ходе

Если чужой ход уже открыт и не истёк (TTL 30 минут) — новый beginMutation
выбрасывает ошибку.

### P1-014: Освобождение зависших блокировок

`releaseInterruptedLock()` в MutationOrchestrator:

- Если ход есть НО не отслеживается в `liveMutations` → прерван
- Если ход истёк (старше MUTATION_TTL_MS = 30 мин) → освободить
- Если callID совпадает с входящим → retry, не трогать

### Обработка ошибок

`clearOnError(callId)` вызывается из `handleEvent` при получении
`message.part.updated + status === 'failed'`. Если callId не найден в `liveMutations`,
блокировка будет освобождена при следующем beginMutation через `releaseInterruptedLock`.

### Жизненный цикл мутации

```
[Agent] Bash/Write
  │
  ├── StateMachineRuntime.handleToolBefore()
  │   └── mutationBefore()
  │       └── MutationOrchestrator.beginMutation()
  │           ├── Queue.enqueue()
  │           │   ├── releaseInterruptedLock() [P1-014]
  │           │   ├── resolveMutationRun() → run | ambiguous | none
  │           │   ├── session.activeOperations[callID] = { runId?, taskId?, agent, … }
  │           │   └── session.verifications = []
  │           └── liveMutations.set(callID, { rootSessionId, stageBefore })
  │
  ├── [Bash/Write executes]
  │
  └── StateMachineRuntime.handleToolAfter()
      └── mutationAfter()
          └── MutationOrchestrator.finishMutation()
              ├── liveMutations.delete(callID)
              └── Queue.enqueue()
                  ├── processScopeAndInvariants():
                  │   ├── computeChangeScope() → git status --porcelain
                  │   ├── session.changedFiles = [...]
                  │   └── validateFiles() → invariant checks
                  ├── finishMutation(session, finalPassed):
                  │   ├── delete session.activeOperations[callID]
                  │   └── run.checks = passed|failed   (вне цикла — session.checks)
                  ├── tryApplyTransitions()
                  └── Post-factum validation → checkTransition()
```

## Профили (Profiles)

### Структура директории

```
.opencode/profiles/
  base/                          ← наследуется всеми
    profile.json                 ← metadata: id, schemas, agents, invariants
    state-machine.yaml           ← transitions, stages, guards
    invariants.ts                ← EXPORT const INVARIANTS: InvariantCheck[]

  android/                       ← extends: base
    profile.json                 ← schemas: [state-machine.yaml], agents: [code, review, ...],
    state-machine.yaml                     invariants: [LF_ONLY, KOTLIN_STACK, ...]
    invariants.ts                ← Android-specific проверки

  harness/                       ← extends: base
    profile.json                 ← self-edit профиль для разработки самого плагина
    invariants.ts
```

### profile.json — Профиль metadata (src/schema/profile-metadata.ts)

```typescript
interface ProfileMetadata {
  id: string;
  description?: string;
  extends?: string; // ID родительского профиля (base, android, ...)
  schemas?: string[]; // Файлы YAML-схем (state-machine.yaml)
  agentsDir?: string; // Директория агентов (default: 'agents')
  skillsDir?: string; // Директория скиллов (default: 'skills')
  agents?: string[]; // Список агентов для профиля
  skills?: string[]; // Список скиллов для профиля
  invariants?: string[]; // ID инвариантов для включения
}
```

### ProfileResolver (src/profile-resolver.ts)

**Цепочка extends:**

```
android → base → (конец)
harness → base → (конец)
```

1. `resolve(profileId)` — загрузка extends chain
2. `resolveProfileExtends(profileId)` — обход цепочки с детектом циклов
3. `resolveSchemas(chain, schemaFiles)` — для каждого schemaFile:
   - Загрузка через `SchemaLoader.loadSchemaFile()`
   - Если есть `extends` в схеме — merge через `mergeSchemas()`
4. Наследование полей: если у дочернего профиля поле не задано — берётся из первого родителя, у которого оно есть

### ProfileResolver (src/profile-resolver.ts) — детали

**resolve(profileId: string): ResolvedProfile**

```typescript
interface ResolvedProfile {
  metadata: ResolvedMetadata; // id, agents[], skills[], invariants[], agentsDir, skillsDir
  schemas: ResolvedSchema[]; // смерженные YAML-схемы
}
```

Алгоритм:

1. `loadAll()` — сканирует `profilesDir/*/profile.json`, парсит через `ProfileMetadataSchema`
2. `resolveProfileExtends(id)` — обход цепочки `extends` с детектом циклов через `visited: Set<string>`
3. Наследование скаляров: agents, skills, invariants берутся из первой записи в chain, где они заданы (дочерний приоритет)
4. `resolveSchemas(chain, schemaFiles)` — для каждого уникального schema-файла из всей цепочки
5. `resolveSingleSchema(schemaFile, chain)` — загрузка файла + schema-level extends с merge

**listProfiles(): ProfileMetadata[]**

Плоский список profile.json без разрешения extends. Кешируется после первого вызова.

### SchemaLoader (src/schema-loader.ts) — детали

**loadSchemaFile(profileId, schemaFilename): ProfileSchema | null**

Загрузка YAML-файла `profilesDir/{profileId}/{schemaFilename}`. Шаги:

1. `fs.access()` — проверка существования файла (null если нет — graceful degradation)
2. `YAML.parse(await readFile(...))` — парсинг YAML
3. `ProfileSchemaSchema.parse(raw)` — Zod-валидация
4. Возвращает `ProfileSchema` или null

**mergeSchemas(base, extension): ResolvedSchema**

```typescript
// Extension override:
result.stages = extension.stages ?? base.stages;
result.transitions = extension.transitions ?? base.transitions;
result.settings = deepMerge(base.settings, extension.settings);

// deepMerge — рекурсивный merge объектов:
// - значения-объекты: рекурсивный merge
// - значения-скаляры/массивы: extension приоритет
```

**loadSchemaFromPath(dir, filename)**

Аналогично `loadSchemaFile`, но принимает произвольную директорию — для тестов и утилит.

### Пример профиля android:

```json
{
  "id": "android",
  "extends": "base",
  "schemas": ["state-machine.yaml"],
  "agents": ["code", "architect", "review", "qa", "debug", "figma", "rag", "ask", "orchestrator"],
  "skills": ["android-feature-implementation", "android-code-review", ...],
  "invariants": ["LF_ONLY", "KOTLIN_STACK", "NO_FQN", "NO_BANG_BANG", "NO_COMMENTED_CODE",
                 "NAMED_ARGS", "STRING_RES", "RAW_COLOR", "RAW_DP", "NO_BARE_DP", "USE_SPACER_FN"]
}
```

## Инварианты (Profile-specific validation)

### Контракт InvariantCheck (profiles/invariants.types.ts)

```typescript
interface InvariantCheck {
  id: string; // Уникальный ID (LF_ONLY, KOTLIN_STACK, ...)
  severity: 'error' | 'warning'; // error → gate failed, warning → log
  check: (content: string, filePath: string, absolutePath: string) => string | null;
  // null = OK, string = нарушение
  appliesTo?: (filePath: string) => boolean; // Фильтр файлов (проверка расширения)
}
```

### загрузка инвариантов (src/app/invariants.ts)

1. `getAllProfileInvariants(profileId, profilesDir)`:
   - Resolve профиля через `ProfileResolver` → `resolved.metadata.invariants` (список ID)
   - Dynamic `import(profilesDir/profileId/invariants.ts)` — `mod.INVARIANTS`
   - Fallback через `file://` протокол для совместимости Bun/Node
   - Фильтрация: только ID из metadata.invariants

2. `validateFiles(filePaths, invariants, rootDirectory)`:
   - Для каждого файла с расширением .kt, .ts, .json, .md:
   - Чтение содержимого
   - Для каждого InvariantCheck, где `appliesTo(file)`:
     - Вызов `check(content, filePath, absolutePath)`
     - Если вернула строку → `InvariantViolation`

3. `validateFilesForProfile(filePaths, profileId, profilesDir)`:
   Обёртка: `getAllProfileInvariants` + `validateFiles`

### Когда запускаются

1. **После edit/write/apply_patch** (handleFileToolAfter): проверка каждого написанного файла
2. **В конце мутации** (processScopeAndInvariants): проверка всех changedFiles

В обоих случаях результат аппендится в `output.output` как `[workflow-validation]` блок.

### Встроенные профили инвариантов

**base/invariants.ts:**

- `LF_ONLY` (error) — CRLF-окончания строк

**harness/invariants.ts:**

- `LF_ONLY` (error) — CRLF
- `BROKEN_IMPORT` (error) — нерезолвимые относительные импорты (ручной парсинг import specifiers)
- `CONSOLE_LOG` (warning) — `console.log()` в production-коде
- `INVALID_JSON` (error) — некорректный JSON (кроме lock-файлов)
- `ANGLICISM` (warning) — английские слова в русском тексте (в MD и TS string literals)

**android/invariants.ts:**

- `LF_ONLY` (error) — CRLF
- `KOTLIN_STACK` (error) — импорты java.awt, javax.swing, org.springframework
- `NO_FQN` (error) — fully qualified имена вместо импортов
- `NO_BANG_BANG` (error) — оператор `!!`
- `NO_COMMENTED_CODE` (error) — закомментированный код
- `NAMED_ARGS` (warning) — позиционные аргументы вместо named
- `STRING_RES` (warning) — русский текст в UI-коде вместо strings.xml
- `RAW_COLOR` (warning) — `Color(0xFF...)` вместо ColorPalette
- `RAW_DP` (warning) — голые `.dp` вместо Spacing/Radius токенов
- `NO_BARE_DP` (warning) — `.dp` значения, совпадающие с токенами
- `USE_SPACER_FN` (warning) — `Spacer(Modifier.height/width(...))` вместо `SpacerX()`

## Guardrails (src/app/guardrails.ts)

### validateUserInput(input: string): GuardResult

Проверка входящих данных от пользователя на набор RegExp-паттернов:

```
Паттерны разделены на категории с severity:

PROMPT_INJECTION (block)         — 20 паттернов на RU/EN
  "ignore all previous instructions", "forget your rules",
  "pretend to be unrestricted", "ты теперь без ограничений",
  "новые правила:", ...

ROLE_OVERRIDE (block)            — 14 паттернов
  "you are a different AI", "your role has changed",
  "ты другой агент", "твоя роль изменилась", ...

SYSTEM_EXTRACTION (block)        — 16 паттернов
  "output your system prompt", "repeat the words above",
  "выведи свои инструкции", "повтори слова выше", ...

CODE_INJECTION (warn)            — 15 паттернов
  "os.system(", "eval(", "rm -rf /", "curl ... | sh", ...

CONTEXT_CONFUSION (warn)         — custom-проверка
  Счётчик спам-слов (stop, exit, reset, очисти, забудь, сотри):
  >= 3 → срабатывание. Или >30 emoji.

INDIRECT_INJECTION (warn)        — 14 паттернов
  "the user told me to ignore", "admin said to",
  "пользователь сказал игнорировать", "срочное системное сообщение", ...

DATA_EXFILTRATION (warn)         — 18 паттернов
  "cat ~/.ssh", "cat /etc/passwd", "git push --force",
  "printenv", "curl ... Bearer ...", ...
```

### sanitizeToolOutput(input: string): { output, hits }

Санитизация исходящих данных: все block-паттерны заменяются на `[BLOCKED:RULE_ID]`.

### extractUserText(parts): string

Извлекает текст пользователя из частей сообщения SDK, исключая синтетические.
Используется для анализа user input перед вызовом validateUserInput.

## Change Scope (src/app/change-scope.ts)

### Определение изменений

`computeChangeScope(cwd, baseline, moduleRoot?)`:

1. `dirtyPaths(cwd)` — `git status --porcelain --untracked-files=all`
   - Обработка rename (R) и copy (C)
   - Дедупликация через Set
2. Для каждого dirty path:
   - `hash(cwd, path)` — SHA-256 текущего содержимого файла
   - Сравнение с baseline (если хеш изменился или файла не было в baseline)
3. Нормализация путей через `relative()` + защита от path traversal

`captureBaseline(cwd)` — снимок хешей всех dirty файлов (для последующего diff).

Используется в `processScopeAndInvariants` для заполнения `session.changedFiles`.

## Task Provider Abstraction (src/app/provider.ts)

### Interfaces

```typescript
interface TaskProvider {
  getTask(id: string): Promise<Task>;
  getReadyTasks(): Promise<Task[]>;
  postComment(taskId: string, text: string, author: string): Promise<void>;
}

interface ShellExecutor {
  run(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
  runRaw(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
```

### InMemoryProvider

Для тестов — хранит задачи в Map. `getReadyTasks()` фильтрует по `state === 'ready'`.

### createCliProvider (factory)

Абстракция над внешним issue-трекером через CLI (bd, gh, jira):

```
<cmd> show <id> --json     → Task JSON
<cmd> ready --json          → Task[] JSON
<cmd> comment <id> <text> --actor <author>  → void
```

- Кеширование с TTL (default 30s)
- `escapeArg()` — экранирование `"$\\``
- Создаёт `Bun.spawn` executor через `createBunExecutor(command)`

### Beads Bridge (src/dashboard/beads-bridge.ts)

Обёртка над `bd` CLI для использования в дашборде:

- `getIssue(id)` — получение задачи
- `getReady()` — список готовых задач
- `postComment(issueId, text, author)` — комментарий
- Кеширование 30s
- Graceful degradation: если `bd` CLI недоступен → `{ error, degraded: true }`

## Manifest Presets (src/manifest-presets.ts)

Предопределённые наборы стадий для задач:

```typescript
const TASK_MANIFEST_PRESETS = {
  full: ['dev', 'test', 'review', 'qa'], // Полный цикл
  fix: ['verify', 'dev', 'test', 'review'], // Багфикс
  quick: ['dev'], // Быстрое редактирование
};

// Алиасы для обратной совместимости (P1-009):
const PRESET_ALIASES = {
  feature: 'full', // → ['dev', 'test', 'review', 'qa']
  free_edit: 'quick', // → ['dev']
};
```

### API

```typescript
function getManifest(preset: string): string[];
// Возвращает массив стадий по preset'у
// Автоматически разрешает алиасы
// Возвращает [] для неизвестного preset'а

function isValidManifestPreset(value: string): value is TaskManifestPreset;
// Проверяет, является ли строка валидным preset-ключом или алиасом

function resolvePresetAlias(value: string): string;
// Разрешает алиас в канонический ключ
// Возвращает исходное значение, если не алиас
```

## TUI (src/tui/tui.ts)

Чистая логика для отображения workflow-секции в боковой панели OpenCode.

### parseRuntimeState(raw: string): ParseResult

```
Tui {
  rootSessionID: string;
  stage: Stage;           // имя задаёт схема профиля
  prevStage: Stage | null;
  nextStage: Stage | null;
  revision: number;
  completedTasks: number;
  totalTasks: number;
  activeOperations: ActiveOperationInfo[];  // на стадии с гейтами их несколько
  gates: GateInfo[];      // сессионные
  taskGates: TaskGateInfo[];  // по прогону задачи: стадия, гейты, checks
  retryBudgets: RetryInfo[];
  raw: Record<string, unknown>;
}
```

### formatSectionLines(view: Tui): string[]

Форматирует 3 строки для отображения в сайдбаре:

```
▶               code               ✕
      ── tasks_ready ── ● code ▼ ── review → ──
              ✓invariants  retry.cycles=1/5
```

### Formatting details (FR-011/FR-012)

`formatDetailsLines(rawText)` — выводит поля сессии в формате key: value,
коллекции (tasks, changedFiles) — с TOP_N=3 и `+N ещё`.

## Dashboard Server (src/dashboard/dashboard-server.ts)

### Отдельный процесс

Сервер не внутри плагина — запускается как независимый процесс:
`bun run src/dashboard/dashboard-server.ts`

### API Endpoints

| Метод | Путь                          | Описание                                              |
| ----- | ----------------------------- | ----------------------------------------------------- |
| GET   | `/`                           | HTML-интерфейс (dashboard.html)                       |
| GET   | `/events`                     | SSE: snapshot + инкрементальные события               |
| GET   | `/api/schema`                 | Контракт дашборда (DashboardSchema)                   |
| GET   | `/api/dump`                   | Все сессии                                            |
| GET   | `/api/session/:id`            | Одна сессия с `stage`                                 |
| GET   | `/api/session/:id/timeline`   | TimelineEvent[] (transitions, gates)                  |
| GET   | `/api/session/:id/invariants` | InvariantViolation[]                                  |
| GET   | `/api/metrics`                | Агрегированные метрики из `.opencode/metrics.jsonl`   |
| GET   | `/api/rag-eval`               | RAG evaluation из `.opencode/rag/eval-results.json`   |
| GET   | `/api/agents/:id/prompt`      | Промпт агента (белый список: orchestrator, code, ...) |
| GET   | `/api/beads/issue/:id`        | Задача из beads                                       |
| POST  | `/api/beads/comment`          | Комментарий в beads                                   |

### Auth & CORS

- Bearer token через `DASHBOARD_TOKEN` env
- CORS через `ALLOWED_ORIGIN` env
- Хост через `DASHBOARD_HOST` (default: 127.0.0.1)

### Dashboard Contract (src/dashboard/dashboard-contract.ts)

Чистые функции для построения сериализуемого представления стейт-машины:

```typescript
interface DashboardSchema {
  states: DashboardState[]; // { id, label, description }
  transitions: DashboardTransition[]; // { from, to, kind, gate }
  gates: DashboardGate[]; // { id, label, required }
  profile: DashboardProfile; // { id, version, invariants, ... }
}
```

### SSE-события

```typescript
type SSESessionEvent =
  | { type: 'transition'; sessionId: string; from: string; to: string; ts: number }
  | { type: 'gate'; sessionId: string; gate: string; status: string; ts: number }
  | { type: 'metric'; ts: number; data: { updated: true } };
```

- `diffSessions()` на каждый чендж — инкрементальные события
- fs.watch + polling 500ms на SESSIONS_DIR
- metrics.jsonl — polling 2s для mtime

## АПИ

### Plugin Tools (SDK tools)

**workflow-create**

```typescript
tool({
  name: 'workflow-create',
  args: { profileId?: string },
  execute: () => { sessionId, profileId, schemaVersion, revision }
})
```

- Проверка существующей сессии (idempotent)
- `createSession(sessionId, profileId)` — начальная сессия с пустым списком гейтов

**workflow-list**

```typescript
tool({
  name: 'workflow-list',
  args: {},
  execute: () => profiles list
})
```

- `listProfiles(profilesDir)` — загружает все profile.json из директории

**workflow-consent**

```typescript
tool({
  name: 'workflow-consent',
  args: {
    files: string[],     // [".opencode/plan/story-42/plan.md"]
    summary: string,     // "Add login page"
    grant?: string,      // "continue" (default)
    decline?: string,    // "stop" (default)
  },
  execute: () => consentTag
})
```

- Читает файлы с диска
- canonicalizePlan → computeSha256 → evidence
- Возвращает XML-тег <consent-request> для встраивания в вопрос

### OpenCode Commands

**sm-status** — состояние текущей workflow сессии
**sm-list** — список всех активных сессий
**sm-session** — создание/переключение/просмотр сессии
**sm-profile** — переключение профиля

Все команды маршрутизируются на subagent `state-machine` (color: #6366F1).

### Public API (src/public-api.ts) — для npm-потребителей

```typescript
async function resolveConfig(profileId: string, profilesDir: string): Promise<ResolvedProfile>;
async function listProfiles(profilesDir: string): Promise<ProfileMetadata[]>;
```

## Переменные окружения

| Переменная                   | По умолчанию                         | Описание                                       |
| ---------------------------- | ------------------------------------ | ---------------------------------------------- |
| `STATE_MACHINE_STORE_DIR`    | `{harnessDir}/state-machine/runtime` | Директория session store                       |
| `STATE_MACHINE_PROFILES_DIR` | `{harnessDir}/profiles`              | Директория профилей                            |
| `STATE_MACHINE_LOG_LEVEL`    | `info`                               | Уровень логирования (debug, info, warn, error) |
| `HARNESS_PROFILE`            | —                                    | Профиль по умолчанию (android, harness)        |
| `HARNESS_AUTO_APPROVE`       | —                                    | Авто-одобрение плана (true/false)              |
| `OPENCODE_HARNESS_DIR`       | `.opencode`                          | Базовый каталог харнесса                       |
| `DASHBOARD_TOKEN`            | —                                    | Bearer token для дашборда                      |
| `DASHBOARD_HOST`             | `127.0.0.1`                          | Хост дашборда                                  |
| `ALLOWED_ORIGIN`             | —                                    | CORS origin для дашборда                       |

## Структура проекта

```
src/
  index.ts                     — Plugin entry point: StateMachinePlugin
  public-api.ts                — resolveConfig, listProfiles (npm API)
  profile-resolver.ts          — Загрузка/наследование профилей
  guard-evaluator.ts           — GuardEvaluator: sandboxed expression eval
  schema-loader.ts             — YAML → ProfileSchema, mergeSchemas

  schema/
    types.ts                   — ProfileMetadata, TransitionDef, StageDef, ...
    profile-metadata.ts        — Zod-схема profile.json
    profile-schema.ts          — Zod-схема schema.yaml

  session/
    session-schema.ts          — Zod-схема WorkflowSession + типы
    session-store.ts           — WorkflowStore: файловое I/O, блокировки
    session-events.ts          — onSessionSaved (глобальные колбеки)
    helpers.ts                 — getGate, setGateStatus, bumpRetry, ...

  domain/
    engine.ts                  — StateMachineEngine, checkTransition, tryApplyTransitions
    session-facts.ts           — SessionFacts проекция
    operation-lifecycle.ts      — beginMutation, finishMutation, clearActiveMutation
    approvals.ts               — approve, decline
    verifications.ts           — confirm, reject
    session-queries.ts         — shellSegments, hasForbiddenGitSubcommand,
                                 isReadOnlyBashCommand
    workflow-result.ts         — парсинг <workflow-result>

  app/
    runtime.ts                 — StateMachineRuntime: hooks + orchestration
    runtime-types.ts           — PromiseChain, OpenCodeSessionClient
    mutation-orchestrator.ts   — begin/finishMutation, scope, invariants
    consent-orchestrator.ts    — before/after consent lifecycle
    consent.ts                 — XML-тег: parseConsentRequest, evidenceOf
    consent-parser.ts          — YAML-блоки: parseConsentRequest, classifyConsentAnswer
    invariants.ts              — Загрузка и прогон InvariantCheck
    guardrails.ts              — validateUserInput, sanitizeToolOutput
    sdd-artifacts.ts           — canonicalizePlan, computeSha256
    change-scope.ts            — computeChangeScope, captureBaseline
    session-queue.ts           — SessionQueue, withSession
    logger.ts                  — LogFn, createLogFn
    provider.ts                — TaskProvider, InMemoryProvider, createCliProvider

  dashboard/
    dashboard-server.ts        — HTTP/SSE сервер
    dashboard-contract.ts      — DashboardSchema, SSESessionEvent
    beads-bridge.ts            — Интеграция с beads issue tracker

  tui/
    tui.ts                     — parseRuntimeState, formatSectionLines

  manifest-presets.ts          — TASK_MANIFEST_PRESETS (full, fix, quick)

profiles/
  base/
    profile.json               — Базовая конфигурация (extends)
    invariants.ts              — LF_ONLY
  android/
    profile.json               — Android-специфичная конфигурация
    invariants.ts              — 11 инвариантов для Kotlin/Compose
  harness/
    profile.json               — Self-edit профиль
    invariants.ts              — 5 инвариантов для TypeScript
  state-machine.yaml           — Базовая схема (фазы, переходы, guards)
  invariants.types.ts          — InvariantCheck, InvariantResult

test/                          — vitest-тесты
docs/                          — roadmap, usage, plugin-architecture, ...
```

## Development

| Команда                                     | Описание                                       |
| ------------------------------------------- | ---------------------------------------------- |
| `mise run build`                            | Сборка `src/index.ts` + `tui.ts` + JSON-schema |
| `mise run test`                             | Все тесты (bun test)                           |
| `mise run test:coverage`                    | Тесты с покрытием                              |
| `mise run lint`                             | ESLint                                         |
| `mise run lint:fix`                         | Автофикс                                       |
| `mise run format`                           | Prettier                                       |
| `bun run typecheck`                         | tsc --noEmit                                   |
| `bun run src/dashboard/dashboard-server.ts` | Запуск дашборда (порт 3456)                    |

---

## Release

See the [RELEASE.md](RELEASE.md) file for instructions on how to release a new version of the module.

---

## Contributing

Contributions are welcome! Please file issues or submit pull requests on the GitHub repository.

---

## License

See the [LICENSE](LICENSE) file for details.
````
