# Что делали `canCommit`, гейт `invariants` и `actionGuards` — запись перед удалением

Снято с HEAD `6e23ed0`, до удаления. Назначение — восстановить действия на
гейтах, когда будет решено, как они должны выглядеть. Здесь только фактическая
последовательность: что вызывается, после чего и перед чем.

---

## 1. `canCommit`

`src/domain/session-queries.ts:86`

```ts
export function canCommit(session, requiredGates): boolean {
  for (const gateId of requiredGates) {
    const gate = getGate(session, gateId);
    if (!gate) return false;
    if (gate.status !== 'passed') return false;
  }
  const tasks = Object.values(session.tasks ?? {}).flat();
  return tasks.every((t) => t.status === 'completed');
}
```

Два условия: все требуемые гейты `passed`, и все задачи `completed`.
`requiredGates` приходит из `engine.getRequiredGates()` — а он, поскольку поле
не объявлено ни в одном shipped-профиле, всегда возвращает захардкоженное
`['invariants']`.

Сессия стартует с `gates: []` (`src/session/session-store.ts:40`), поэтому в
свежей сессии `getGate` возвращает `undefined` и `canCommit` — `false`. Это
единственное, что сегодня требует, чтобы в сессии вообще состоялся хотя бы один
ход: `tasks.every()` на пустом списке даёт `true`.

### Где стоит в цепочке `tool.execute.before`

`handleToolBefore` (`src/app/runtime.ts:781`), по порядку:

| Шаг | Что |
| --- | --- |
| 0 | `hasWorkflowSession` — нет сессии, плагин не участвует |
| 1 | `guardrailBefore(args)` |
| 1b | `rulesRuntime.handleToolExecuteBefore` |
| 2 | `consentBefore` (`question`) — при срабатывании ранний `return` |
| 3 | `handleTaskBefore` — только для `[workflow-task:…]` |
| 3b | `scopeBefore` |
| **4** | **`commitBefore`** ← здесь |
| 5 | `mutationBefore` |

`commitBefore` (`runtime.ts:2378`), только для `bash`:

1. `extractBashCommand(args)`
2. `hasForbiddenGitSubcommand(command)` → `throw WorkflowBlockedError('Direct git commit/push is blocked. Use commit-task.ts instead.')`
3. `isCommitTaskCommand(command)` → `handleCommitTaskBefore`

`handleCommitTaskBefore` (`runtime.ts:1271`), по порядку:

1. `loadGoverning(sessionID)` — `null` → тихий `return`, вызов не наш
2. `resolveEngine(profileId, schemaId)`
3. `engine.getRequiredGates()`
4. **`canCommit(session, requiredGates)`** — `false` → `throw WorkflowBlockedError('Cannot commit: not all gates passed or tasks completed')`
5. `getPreCommitHead()`
6. `session.deliveryPermit = { callID, preCommitHead, expectedFiles, startedAt }`,
   где `expectedFiles` = `changedAgainstHead(projectDir)` ∩ `session.changedFiles`
7. `store.save(session)`

Стадию сессии этот путь **не проверяет вообще**.

### Что происходит после

`handleToolAfter`, по порядку: `guardrailAfter` → `invariantsAfter` (только
`task`) → `handleWorkflowResult` → `handleFileToolAfter` → **`handleCommitTaskAfter`**
(`bash`) → `consentAfter` → `mutationAfter` → `transitionAfter`.

`handleCommitTaskAfter` (`runtime.ts:1358`):

1. нет сессии → `return`
2. нет `deliveryPermit` → `return`
3. `permit.callID !== callID` → `return`
4. `getPreCommitHead()`; HEAD не двинулся или `unknown` → `return`, permit остаётся
5. `git diff-tree --no-commit-id --name-only -r --root <HEAD>` → `committed`
6. `committed` пуст или нечитаем → отказ: `deliveryPermit = null`, в вывод
   `[workflow-commit-rejected]`, `save`
7. `committed` не совпал с `expectedFiles` → тот же отказ
8. успех: `deliveryReceipt = HEAD`, `deliveryPermit = null`, `save`

### Цепочка, которую держал `canCommit`

Три звена, и первое — он:

```
canCommit → deliveryPermit → deliveryReceipt → ребро commit → done
```

`base.yaml:124` — `guard: "session.deliveryReceipt != null"`. Receipt пишется
только против permit, permit выдаётся только после `canCommit`.

---

## 2. Гейт `invariants`

Единственный гейт, чьё имя зашито в рантайм. `review` и `qa` рождаются из
`<workflow-result>` агента; этот считает движок сам, шелля в git.

### Два носителя, разная семантика

| | `session.gates.invariants` | `run.gates.invariants` |
| --- | --- | --- |
| пишется | `src/domain/operation-lifecycle.ts:116/132/144` через `setGateStatus` | `src/app/runtime.ts:1718` → `:1807` |
| повод | завершение `bash` / `write` | after-хук `task` |
| считает | `processScopeAndInvariants` (`src/app/mutation-orchestrator.ts:139`) | `invariantsAfter` (`src/app/runtime.ts:1656`) |
| читает в проде | `canCommit` | guard `base.yaml:66` — `task.gates.invariants == 'passed'` на ребре `code → verify` |

### Как считался вердикт

`processScopeAndInvariants` — `finalPassed` стартует как `!metadataFailed` и
только защёлкивается в `false`:

1. `metadata.failed` от инструмента (`:183`)
2. запись вне `task.writeScope` (`:193`)
3. `scopeError` — diff не посчитался (`:205`)
4. `validateFiles` дал errors или бросил (`:221`, `:241`)

`invariantsAfter` — то же по духу, но иначе:

- файлы вне `writeScope` **отфильтровываются**, а не проваливают вердикт (`:1690`)
- `scopeError` → `changed = []`, вердикт остаётся `passed`
- `metadata.failed` не смотрится
- нет baseline → `return`, вердикт не пишется вообще

Входы вердикта: baseline frame (`captureBaseline`, git), текущее состояние
рабочего дерева (`dirtyPaths` + `hash`, `src/app/change-scope.ts:93`),
`projectDir`, `task.writeScope`, `SUPPORTED_EXTENSIONS`,
`profiles/<id>/invariants.ts`, `metadata.failed`.

### Порядок относительно других шагов — было load-bearing

`invariantsAfter` (шаг 1a) обязан идти **до** `handleWorkflowResult` (шаг 1b):
второй считает движение и удаляет операцию, так что вердикт, вынесенный после,
относится к ходу, который уже ушёл.

### Что не удалялось вместе с гейтом

Сама проверка инвариантов. `validateFiles` и диагностика
`[workflow-validation-failed]` в выводе инструмента живут отдельно — агент
получает нарушения в любом случае. Гейт был только способом записать вердикт в
состояние, чтобы на него мог сослаться guard.

---

## 3. `actionGuards`

### Путь поля

| Слой | Где |
| --- | --- |
| Схема | `src/schema/profile-schema.ts:217` — `z.record(z.string())`, ключи произвольные |
| Компилятор | `src/schema/compile-workflow.ts:265` — парсит синтаксис каждого guard-а, имена действий не проверяет |
| Слияние `extends` | `src/schema/schema-loader.ts:172` — `extension.actionGuards ?? base.actionGuards`, целиком |
| Проекция профиля | `src/app/profile-resolver.ts:290` |
| Проекция в движок | `src/app/mutation-orchestrator.ts:57` — копирует всё, фильтр только по типу |
| Чтение | `src/domain/engine.ts:392` |

### Объявления

Только одно действие во всём репозитории — `beginMutation`.

- `profiles/base/base.yaml:128` — `beginMutation: "session.approved('plan')"`
- `android` и `harness` своих не объявляют, наследуют через `extends: 'base/base.yaml'`
- `scripts/host-smoke/profile/comprehensive/comprehensive.yaml:102`
- семь фикстур в `test/fixtures/`, плюс `docs/examples/workflow-schema.example.yaml`

### `canPerformAction` — что делал

`src/domain/engine.ts:362`:

1. `toGuardContext(session)`
2. `deriveStage(session, ctx)` — вычислялась, но использовалась только мёртвым шагом 3
3. **Шаг 1** — `stageLevelGuards[stage]`: поле объявлено в `EngineConfig`
   (`engine.ts:68`), но `schemaToEngineConfig` его не возвращает. Ветка не
   исполнялась никогда
4. **Шаг 2** — `actionGuards[action]` → `evaluateGuardFn`
5. `{ allowed: true }`

Fail-closed: `GuardEvaluator.evaluate` (`src/schema/guard-evaluator.ts:142`)
ловит любое исключение и возвращает `false`. Сломанный guard = запрет.

### Единственный вызов и его место

`src/app/mutation-orchestrator.ts:429`, действие `beginMutation`. Внутри
`MutationOrchestrator.beginMutation` (`:381`), по порядку:

1. `store.load(queue.rootOf(sessionID))` — нет сессии → `return`; ошибка →
   `throw WorkflowBlockedError('Failed to load session or resolve engine')`
2. `resolveEngine`
3. `captureBaseline(projectDir)` — **вне очереди**, настоящий git I/O; падение →
   warn, `frame = undefined`
4. `queue.enqueue(sessionID, …)`:
   - `session === null` → `return`
   - **`engine.canPerformAction(session, 'beginMutation')`** → `!allowed` →
     `throw WorkflowBlockedError('Mutation blocked by engine: <reason>')`
   - `releaseInterruptedLock(session, callID)`
   - доменный `beginMutation(...)` с резолвером первой вложенной стадии;
     бросок → `throw WorkflowBlockedError('Mutation failed: …')`
   - `operation.baseline = frame`
   - `stageBefore = session.currentStage`, `liveMutations.set(callID, …)`

Отказ на шаге `canPerformAction` стоял **после** `captureBaseline` (git I/O уже
сделан впустую) и **перед** `releaseInterruptedLock` и доменным
`beginMutation`. Поэтому отказ не создавал операцию, не снимал залипшие
блокировки и не писал в файл: `SessionQueue` вызывает `store.save(loaded)`
строкой ниже действия (`src/app/session-queue.ts:88-93`), а бросок до неё не
доходит.

### Семантика `false`

Вето на один вызов инструмента, не событие workflow. Стадия не менялась,
переход не пробовался, гейт не ставился, бюджет ретраев не тратился, `failed`
не наступал, файл сессии не переписывался. Узнавал об отказе только агент —
через текст ошибки инструмента.

Отсюда правило применения, если механизм будет восстанавливаться: сюда годится
только условие, которое кто-то извне может снять — согласие оператора или
движение самого графа. Вечно ложный guard даёт тихий дедлок без диагноза.
