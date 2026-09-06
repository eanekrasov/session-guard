# AGENTS.md

Ты будешь выполнять ровно одну инструкцию за раз. Никаких догадок, никаких "сделаю вид что сделал".
Прежде чем ответить — сделай паузу и проверь себя по этим пунктам:
1. Прочитал ли я вопрос полностью? Не пробежал по диагонали, а прочитал каждое слово.
2. Понимаю ли я, что именно нужно сделать? Если нет — спроси. Не начинай делать.
3. Есть ли у меня все данные для ответа? Если нет — запроси. Не додумывай.
4. Проверил ли я факты перед тем как писать? Для файлов — `git diff HEAD -- <file>`, для существования — `ls`. Не "я думаю что файл существует", а ls подтверждает.
5. Не делаю ли я вид, что задача выполнена? Каждый шаг либо реально сделан, либо нет. "Извини" не считается исправлением.

## Build & Test Commands

- **Build**: `mise run build` or `bun build ./src/index.ts --outdir dist --target bun`
- **Test**: `mise run test` or `bun test`
- **Single Test**: `bun test BackgroundTask.test.ts` (use file glob pattern)
- **Watch Mode**: `bun test --watch`
- **Lint**: `mise run lint` (eslint)
- **Fix Lint**: `mise run lint:fix` (eslint --fix)
- **Format**: `mise run format` (prettier)

## Code Style Guidelines

### Imports & Module System

- Use ES6 `import`/`export` syntax (module: "ESNext", type: "module")
- Group imports: external libraries first, then internal modules
- Use explicit file extensions (`.ts`) for internal imports

### Formatting (Prettier)

- **Single quotes** (`singleQuote: true`)
- **Line width**: 100 characters
- **Tab width**: 2 spaces
- **Trailing commas**: ES5 (no trailing commas in function parameters)
- **Semicolons**: enabled

### TypeScript & Naming

- **NeverNesters**: avoid deeply nested structures. Always exit early.
- **Strict mode**: enforced (`"strict": true`)
- **Classes**: PascalCase (e.g., `BackgroundTask`, `BackgroundTaskManager`)
- **Methods/properties**: camelCase
- **Status strings**: use union types (e.g., `'pending' | 'running' | 'completed' | 'failed' | 'cancelled'`)
- **Explicit types**: prefer explicit type annotations over inference
- **Return types**: optional (not required but recommended for public methods)

### Error Handling

- Check error type before accessing error properties: `error instanceof Error ? error.toString() : String(error)`
- Log errors with `[ERROR]` prefix for consistency
- Always provide error context when recording output

### Linting Rules

- `@typescript-eslint/no-explicit-any`: warn (avoid `any` type)
- `no-console`: error (minimize console logs)
- `prettier/prettier`: error (formatting violations are errors)

## Testing

- Framework: **vitest** with `describe` & `it` blocks
- Style: Descriptive nested test cases with clear expectations
- Assertion library: `expect()` (vitest)

## Destructive Operations Protocol

Этот протокол **обязателен**. Нарушение — баг в рассуждениях агента.

### 1. `git checkout` — только для файлов, которые я сам закоммитил

Если файл не в git (untracked, newly added без commit) — `git checkout` его не трогает, и агент не должен на него полагаться.

### 2. `rm -rf` — только для временных/сборочных директорий

Разрешённые аргументы:
- `/tmp/*`, `/var/folders/*`
- `.memory/`
- `dist/`
- `node_modules/`

Всё остальное — стоп, даже если файл создан агентом в этой сессии.

### 3. Очистка через переименование, а не удаление

Вместо `rm -rf src/app/`:

```bash
mv src/app/ src/app.bak/
```

Бэкап удаляется только после явного подтверждения, что новые файлы работают.

### 4. `git reset --hard` — запрещён при незакоммиченных изменениях

`git reset HEAD <file>` — OK (снимает с индекса).
`git reset --hard <ref>` — стоп, если есть staged/unstaged изменения.

### 5. Безопасный откат — перечисление и `rm` каждого файла

Если apply создал нежелательные файлы:
1. Перечислить все файлы
2. Показать список
3. Удалить `rm file1 file2` (каждый отдельно, без `-rf` рекурсии)
4. Не использовать `git checkout` или `git reset`

### 6. Перед удалением untracked файлов — проверить, не код ли это

Перед `rm` untracked файла: проверить, что это действительно временные данные (.tmp, .log, dist), а не исходный код, созданный apply без коммита.

### 7. Перед любым edit/write — git diff HEAD

Перед каждым edit, write, или откатом через edit выполни:

```bash
git diff HEAD -- <file>
```

Цель — увидеть, есть ли незакоммиченные изменения в файле до твоих правок.
Если diff пустой — файл совпадает с HEAD, ты работаешь с чистой версией.
Если diff не пустой — в файле уже есть изменения (твои или пользователя).
Ты должен это явно видеть и учитывать.

После edit — снова `git diff HEAD -- <file>` и убедиться, что результат
совпадает с ожидаемым (только твои целевые правки, без случайных изменений).

Для untracked файлов — `git status -- <file>` перед rm.

## Границы задачи (Scope Boundary)

Если в ходе выполнения обнаружена проблема, не указанная в задаче:

1. **Зафиксировать** — записать, что найдено, где, в чём суть
2. **Спросить** — «это чинить в этой задаче или отдельно?»
3. **Не чинить без ответа**

Это касается любых правок, которые:
- Меняют поведение (текст, формат, тайминги, логику)
- Трогают типы, сигнатуры, интерфейсы вне зоны задачи
- Добавляют или убирают поля в API/логгере/data flow
- Ослабляют или усиливают контракты

Исключение: правка, без которой задача **объективно не может быть завершена** (например, удаление @ts-nocheck требует исправить ошибку на той же строке). Если сомневаешься — спроси.

## Memory

- Store temporary data in `.memory/` directory (gitignored)

## Маркеры слишком частной реализации (implementation-specific naming)

Плагин спроектирован как **универсальный** — он не должен завязываться на конкретные поля
или константы встроенного `state-machine/` харнесса. Следующие наименования являются
**маркерами слишком частной реализации** и должны быть заменены на обобщённые аналоги:

| Маркер                            | Проблема                                                                                                                                    | Обобщение                                                         |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| `planApproved`                    | Название поля подразумевает, что план — единственный способ согласования. В общем случае approval — это сущность с типом, а не булево поле. | `approvals: Approval[]` + `granted('plan')`                       |
| `pendingPlanApproval`             | Слишком конкретно: поле завязано на структуру плана (`planRef`, `evidence`). В общем случае — очередь решений.                              | `pendingApprovals: Approval[]`                                    |
| `bugVerified`                     | Завязано на конкретный тип задачи (bug fixing). Плагин не должен знать о «багах».                                                           | `resultVerified` / `stageCompleted`                               |
| `verificationPassed`              | Тот же маркер, переименованный вариант `bugVerified`. Остаётся завязан на булево поле вместо сущности верификации.                          | `verifications: Verification[]` + `hasVerification('stage')`      |
| `planEvidence`                    | Завязано на план и конкретную схему доказательства (SHA-256 файла).                                                                         | `evidence: Evidence[]`                                            |
| `planDeclined`                    | Булево поле вместо очереди решений.                                                                                                         | `declinedReasons: string[]` или `lastDecision.type === 'decline'` |
| `planRef`                         | План как единственная сущность.                                                                                                             | `referenceId` / `documentRef`                                     |
| `specRef`                         | Название файла специфично для OpenSpec/SDD.                                                                                                 | `documentRef`                                                     |
| `consentedCallIDs`                | Завязано на механику callID консент-запроса.                                                                                                | `processedDecisionIds: string[]`                                  |
| `commitPermit` / `commitHash`     | Завязано на git-коммит. Другие рантаймы могут иметь другую фиксацию.                                                                        | `deliveryPermit` / `deliveryReceipt`                              |
| `baselineHashes` / `changedFiles` | Завязано на git diff.                                                                                                                       | `scopeSnapshot` / `modifiedArtifacts`                             |
| `invariantViolations`             | Название из харнесс-терминологии.                                                                                                           | `validationRecords`                                               |
| `retryBudgets` / `cycles`         | Ключ `cycles` завязан на специфичный для харнесса retry-механизм.                                                                           | `retryBudgets: Record<string, { attempts: number; max: number }>` |
| `rootSessionID`                   | OpenCode specific.                                                                                                                          | `sessionGroupId`                                                  |

### Почему это важно

1. **Переносимость**: плагин может работать с разными клиентами (OpenCode, Claude Code, Codex),
   у каждого своя терминология.
2. **Spec-first**: название поля должно отражать business concept, а не реализацию.
3. **Избежать copy-paste**: встроенная версия харнесса содержит эти названия как legacy.
   Плагин должен учиться на её ошибках.

### Правило

Если название поля содержит:
- упоминание конкретного workflow-артефакта (`plan`, `spec`, `bug`, `commit`),
- внутреннюю механику конкретного клиента (`callID`, `sessionID`, `rootSession`),

то это **маркер слишком частной реализации**, и поле нужно переименовать или абстрагировать.

### Требование: полное переписывание, не косметика

Обнаружение маркера означает, что **вся реализация, построенная вокруг него, должна быть переписана**,
а не просто переименована. Недостаточно заменить `planApproved` на `approved` через sed:
- **Данные**: измени структуру session так, чтобы approval не знал о планах (например, очередь approvals вместо pendingPlanApproval)
- **Логика**: перепиши deriveStage, guard-выражения, transition guards так, чтобы они не зависели от `plan.*` и `bug.*` полей
- **API**: публичные методы (approvePlan, declinePlan, markBugVerified) замени на обобщённые (approve, decline, setStageResult)
- **GuardEvaluator**: guard-выражения вида `session.planApproved == true` замени на `granted('plan')`

Критерий принятия: ни одно из перечисленных в таблице наименований не встречается в исходниках плагина.
Частичное переименование (например, только поле в типе, но не в guard-выражениях) — это не исправление.

## Project Context

- **Type**: ES Module package for Bun modules
- **Target**: Bun runtime, ES2021+
- **Purpose**: General-purpose Bun module development
