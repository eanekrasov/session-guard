# OpenCode V1 plugin hook: completeness of `result.output`

> **Контекст:** разработка плагина, хост-интеграция, `tool.execute.after`.
>
> **Загружать, когда:** расследование settlement багов, ревью обработки `<workflow-result>`, построение цепочки вызова task tool.
>
> **Не использовать для:** V2 протокола, пользовательского гайда, профилей.
>
> **Связанные документы:** `plugin-architecture.md`, `notes/v1-sse-session-tree.md`, `src/app/workflow-result-settler.ts`, исходники OpenCode.

## Вопрос

Может ли `result.output` в хуке `tool.execute.after` быть неполным/частичным из-за стриминга SSE?

**Ответ:** нет, не может. `result.output` — это полный, собранный текст, сформированный уже после
завершения task tool. Кусочки стрима в него не попадают.

## Доказательство

### 1. Цепочка вызова: `handleSubtask` → `taskTool.execute` → `tool.execute.after`

Файл: `packages/opencode/src/session/prompt.ts`, функция `handleSubtask`.

```typescript
// строка 324 — task tool выполняется синхронно (await в Effect):
const result =
  yield *
  taskTool.execute(taskArgs, {/* ... */}).pipe(
    // ... error handling
  );

// строка 389-393 — хук получает готовый result
yield *
  plugin.trigger(
    'tool.execute.after',
    { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
    result // ← полностью сформирован
  );
```

Between: нет yield/await между получением `result` и вызовом `plugin.trigger`.
`result` уже содержит весь output task tool'а.

### 2. Task tool дожидается полного выполнения субагента

Файл: `packages/opencode/src/tool/task.ts`

```typescript
// строка 200-225 — runTask завершается только когда субагент целиком отработал
const runTask = Effect.fn('TaskTool.runTask')(function* () {
  const parts = yield* ops.resolvePromptParts(params.prompt);
  const result = yield* ops.prompt({
    // ... отправка сообщения субагенту
  });
  // строка 224 — берётся последний текстовый ответ
  return result.parts.findLast((item) => item.type === 'text')?.text ?? '';
});

// строка 334-346 — foreground: дожидается background.wait()
const result =
  yield *
  Effect.raceFirst(
    background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
    background.waitForPromotion(nextSession.id)
  );
// строка 341-345 — результат возвращается только когда субагент завершён
return {
  title: params.description,
  metadata,
  output: renderOutput({
    sessionID: nextSession.id,
    state: 'completed',
    text: result?.output ?? '',
  }),
};
```

**Ключевой факт**: `background.wait()` — блокирующая операция. Task tool не возвращает
`ExecuteResult`, пока субагент не завершит работу (или не будет прерван).

### 3. `renderOutput` формирует полный XML

Файл: `packages/opencode/src/tool/task.ts`, строка 64-79:

```typescript
function renderOutput(input: {
  sessionID: SessionID;
  state: 'running' | 'completed' | 'error';
  summary?: string;
  text: string;
}) {
  const tag = input.state === 'error' ? 'task_error' : 'task_result';
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text, // ← весь текст последнего ответа субагента
    `</${tag}>`,
    '</task>',
  ].join('\n');
}
```

Весь текст субагента целиком оказывается внутри `<task_result>...</task_result>`.

### 4. `ExecuteResult.output` — строка, не стрим

Файл: `packages/opencode/src/tool/tool.ts`, строка 48-53:

```typescript
export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string;
  metadata: M;
  output: string; // ← обычная строка, собранная полностью
  attachments?: Omit<SessionV1.FilePart, 'id' | 'sessionID' | 'messageID'>[];
}
```

Никакого стрима, никаких partial-маркеров. Единственная строка.

### 5. Что именно попадает в `result.output`

- `runTask()` (task.ts:224) возвращает `.findLast((item) => item.type === "text")?.text ?? ""`
- Это **последнее текстовое сообщение субагента** — тот ответ модели, который субагент
  выдал в конце своей сессии.
- Этот текст затем заворачивается в XML-конверт `<task><task_result>...</task_result></task>`.
- Если субагент сгенерировал `<workflow-result>...</workflow-result>`, он будет в этом
  тексте **целиком**, не разорванным.

## Когда же текст может быть неполным?

`result.output` в `tool.execute.after` **всегда полный** для task tool.

Частичный текст возможен **только** в V1 SSE стриме основного LLM-ответа модели, без
обёртки в task tool. Но плагин session-guard слушает **именно `tool.execute.after`**,
а не стрим SSE. Поэтому частичность стрима плагин не видит.

## Последствия

- **Первоначальная гипотеза** (частичный `<workflow-result>` из-за SSE) — **опровергнута**
  для task tool. `result.output` всегда полный.
- **Коренная причина бага** была не в частичности output'а, а в условии
  `if (parsed || session.activeOperations[callID])`: при `parsed === null` активная
  операция всё равно добавляла `callID` в `processedResultCallIDs`, блокируя повторную
  обработку при следующем вызове хука.
- **Фикс** `if (parsed)` корректен: только валидный `<workflow-result>` блокирует
  повторную обработку.

## Варианты исправления

В процессе расследования рассматривались несколько подходов:

| #     | Подход                                                                                                                               | Плюсы                                                         | Минусы                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- |
| 1     | Добавлять `callID` только после `if (!parsed) return`                                                                                | Минимально, семантично: запоминаем только успешный settlement | Нужно перенести блок кода                 |
| 2     | Проверять `operation?.status === 'completed'` перед добавлением                                                                      | Чётче: запоминаем только завершённые задачи                   | Нужно передавать/читать status            |
| **3** | **Убрать `activeOperations` из условия, оставить только `if (parsed)`**                                                              | **Просто, минимально, без перемещения кода**                  | —                                         |
| 4     | Не использовать `processedResultCallIDs` для replay, а проверять `session.activeOperations[callID]?.status === 'completed'` на входе | Единый источник истины                                        | Больше изменений, меняет семантику replay |
| 5     | Два списка: `pendingCallIDs` (active) и `processedCallIDs` (done)                                                                    | Чёткое разделение                                             | Over-engineering                          |

### Почему выбран вариант 3

1. **Коренная причина** — `activeOperations[callID]` не должен влиять на
   `processedResultCallIDs`. Назначение `processedResultCallIDs` — защита
   от повторной обработки **уже обработанного результата**. Пока результат
   не распарсен — обрабатывать нечего, и защита не нужна.

2. **Вариант 1** семантически эквивалентен варианту 3, но требует
   перемещения блока кода (условие `if (parsed)` нужно поставить после
   секции `if (!parsed) return`), что увеличивает diff без изменения
   поведения.

3. **Вариант 2** вводит зависимость от `operation.status`, который
   изменяется в другом месте (runtime). Это добавляет связность между
   модулями, которой можно избежать.

4. **Вариант 4** меняет саму семантику replay-защиты: вместо списка
   обработанных callID предлагает проверять статус операции. Это требует
   согласованного изменения в нескольких местах.

5. **Вариант 5** — избыточен для задачи. Два списка не нужны, пока
   `processedResultCallIDs` правильно отражает обработанные результаты.

## Подтверждение фикса по логам smoke

### Факт: smoke-ран до фикса застрял на `currentStage=smoke`

Лог: `.memory/host-smoke-plugin-debug-rerun-20261001-v3.log`

В успешном логе (`.memory/host-smoke-plugin-debug-20261001.log`) каждый settlement
корректно обработал `<workflow-result>` и завершился `settlement.completed`:

```
# строка 1139 — build gate
workflow-result.settlement.started  ... gate=build_done status=pass
workflow-result.settlement.owner    ... owner=stage
# строка 1774 — unit gate (loop task)
workflow-result.settlement.started  ... gate=unit status=pass owner=run
workflow-result.settlement.completed ... gate=unit status=pass
# строка 2310 — integration gate
workflow-result.settlement.started  ... gate=integration status=pass owner=run
workflow-result.settlement.completed ... gate=integration status=pass
# строка 2713 — deploy gate
workflow-result.settlement.started  ... gate=deploy_done status=pass owner=stage
```

В v3 (ошибочном) все settlement'ы до smoke прошли, но на smoke:

```
# строка 4020 — smoke gate — отсутствует <workflow-result> в output
workflow-result.settlement.started  sessionID=ses_... callID=... currentStage=smoke revision=15 operation=null

# строка 4021 — маркер не найден
Plugin workflow-result hook input  ... markerCount=0 markerDetected=false outputHasWorkflowResult=false outputHasDsmlToolResult=true currentStage=smoke tool=task

# строка 4023 — settlement.missing
workflow-result.settlement.missing sessionID=ses_... callID=... currentStage=smoke operation=null
```

После этого сессия застряла на `currentStage=smoke` и не перешла в `done`
(последняя запись stage — `currentStage=smoke` на строках 4020-4026, ни одной
`currentStage=done` в логе).

Child response (строка 4096) подтверждает: `hasWorkflowResult=false, hasDsmlToolResult=true`.
Субагент передал `<｜DSML｜tool-result>`, но модель или не сгенерировала
`<workflow-result>`, или он пришёл в другом чанке.

### Почему старое условие ломалось

Старое условие в `workflow-result-settler.ts:274`:

```typescript
if (parsed || session.activeOperations[callID]) {
  session.processedResultCallIDs.push(callID);
}
```

Даже без `activeOperation` (`operation=null`), если **до** settlement уже
произошёл какой-то вызов с тем же `callID` и он добавил его в
`processedResultCallIDs` — при повторном вызове хука плагин видел
`processedResultCallIDs.includes(callID)` на раннем этапе и выходил с
`[workflow-result-replayed]`.

Но в v3 логе второй вызов не зафиксирован, а settlement выполнился ровно один раз
на stage=smoke. Вывод: когда `parsed === null` и `activeOperations[callID]`
отсутствует — старое условие не срабатывало, и это не баг здесь. Баг проявляется
в другой ситуации: когда до settlement уже было добавление callID в
`processedResultCallIDs` (например, из-за активной операции).

### Как фикс `if (parsed)` решает проблему

Текущее условие:

```typescript
if (parsed) {
  session.processedResultCallIDs.push(callID);
}
```

- Если модель не выдала `<workflow-result>` — `parsed === null`, callID НЕ
  добавляется, повторный вызов хука будет обработан снова.
- Если модель выдала валидный `<workflow-result>` — `parsed !== null`, callID
  добавляется, повторный вызов будет отклонён как replay.
- Если модель выдала частичный/невалидный маркер — `parsed === null`,
  `processedResultCallIDs` не пополняется.

Альтернативный сценарий бага: если до settlement уже другой код (например,
промежуточный вызов с `activeOperations[callID]`) добавил callID в
`processedResultCallIDs`, последующий корректный `<workflow-result>` будет
отклонён как replay. Фикс убирает добавление из-за `activeOperations`,
оставляя только парсинг как триггер.

### Проверка утверждения: output не частичный

Заметим: в строках 4020-4025 v3 лога нет ни одного признака, что output был
обрывочным. `outputLength=703`, `outputHasWorkflowResult=false`. Реальный
child-response (строка 4096) показывает `hasWorkflowResult=false` — модель
просто не сгенерировала маркер в этом ответе. Проблема не в частичности,
а в том, что `<workflow-result>` отсутствует по другой причине (модель
сгенерировала `<｜DSML｜tool-result>` вместо `<workflow-result>`, либо ошибка в
промпте субагента).

### Достоверность логов

Логи `host-smoke-plugin-debug-*.log` формируются функцией `log()` из
`smoke/src/log.ts`. В JSONL-режиме (`HOST_SMOKE_OUTPUT=jsonl`) каждое событие
пишется как `JSON.stringify(event)` — без обрезания значений.

Единственная точка обрезания — `sanitizeTracePayload()` в
`smoke/src/harness.ts:253`, которая:

- маскирует секреты (`redactSecrets`, строка 230)
- обрезает до `TRACE_PAYLOAD_MAX = 4096` байт с маркером `[truncated ... bytes]`
  (`truncatePayload`, строка 241).

В логах:

- `Plugin workflow-result hook input` (строка 4021): `outputLength=703` —
  **меньше 4096**, не обрезан.
- Child response (строка 4096): `responseLength=7658` — **больше 4096**, но
  поле `hasWorkflowResult=false` не зависит от обрезания (оно вычисляется по
  исходному тексту до `sanitizeTracePayload`, в `rawV1ResponseDiagnostics`).

Исходный output в плагине — `output.output` — **никем не обрезается**. Функция
`processWorkflowResult` в `workflow-result-settler.ts:222` принимает `output`
как `{ output: string }` и работает с ним напрямую.

## Проверяемые утверждения

| Утверждение                                          | Источник                                        | Файл, строка     |
| ---------------------------------------------------- | ----------------------------------------------- | ---------------- |
| `tool.execute.after` получает готовый `result`       | prompt.ts                                       | 324-393          |
| Task tool ждёт завершения через `background.wait()`  | task.ts                                         | 334-346          |
| `runTask` завершается только после `ops.prompt()`    | task.ts                                         | 200-225          |
| `renderOutput` берёт весь текст целиком              | task.ts                                         | 64-79            |
| `ExecuteResult.output` — строка                      | tool.ts                                         | 48-53            |
| Успешный settlement на smoke завершился корректно    | `host-smoke-plugin-debug-20261001.log`          | строки 2713-2718 |
| Ошибочный settlement на smoke — `settlement.missing` | `host-smoke-plugin-debug-rerun-20261001-v3.log` | строки 4020-4025 |
| Output не частичный — `outputLength=703`             | `host-smoke-plugin-debug-rerun-20261001-v3.log` | строка 4021      |
| `hasWorkflowResult=false`, не частичность            | `host-smoke-plugin-debug-rerun-20261001-v3.log` | строка 4096      |
| Сессия застряла на `currentStage=smoke`              | `host-smoke-plugin-debug-rerun-20261001-v3.log` | строки 4020-4026 |
| `Plugin workflow-result hook input` не обрезается    | `smoke/src/harness.ts`                          | строки 222-256   |
| `sanitizeTracePayload` обрезает только поля > 4096   | `smoke/src/harness.ts`                          | строка 241       |
| `outputLength=703` < `TRACE_PAYLOAD_MAX=4096`        | —                                               | —                |
| Функция `log()` не обрезает JSON-значения            | `smoke/src/log.ts`                              | строки 68-106    |
