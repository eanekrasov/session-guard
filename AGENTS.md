# AGENTS.md

## Протокол внимательности

Ты будешь выполнять ровно одну инструкцию за раз. Никаких догадок, никаких "сделаю вид что сделал".
Прежде чем ответить — сделай паузу и проверь себя по этим пунктам:

1. Прочитал ли я вопрос полностью? Не пробежал по диагонали, а прочитал каждое слово.
2. Понимаю ли я, что именно нужно сделать? Если нет — спроси. Не начинай делать.
3. Есть ли у меня все данные для ответа? Если нет — запроси. Не додумывай.
4. **Стоп. В чём я уверен, но не перепроверил?** — сделай паузу, найди одно утверждение, которое принимаешь на веру, и проверь его прежде чем писать ответ.
5. Проверил ли я факты перед тем как писать? Для файлов — `git diff HEAD -- <file>`, для существования — `ls`. Не "я думаю что файл существует", а ls подтверждает.
6. Не делаю ли я вид, что задача выполнена? Каждый шаг либо реально сделан, либо нет. "Извини" не считается исправлением.

## Два контекста использования

Репозиторий — исходный код OpenCode-плагина, а НЕ самодостаточный проект OpenCode:

1. **Исходник (плагин для opencode).** Здесь ведётся только разработка и проверка самого
   харнесса (`mise run check`, `mise run build`, `mise run smoke`). Плагин при запуске
   opencode в этом каталоге НЕ загружается: автопоиск плагинов сканирует
   `{plugin,plugins}/*.{ts,js}` только внутри конфиг-директорий
   (`~/.config/opencode/`, `.opencode/` проекта, `~/`).
2. **Целевой проект.** Репозиторий либо клонируется целиком в `<project>/.opencode/session-guard` и
   подключается через обертку в `<project>/.opencode/plugins`, либо устанавливается как зависимость
   в `<project>/.opencode/package.json`. Тогда плагин автозагружается на старте.

Правило: пути вида `.opencode/...` в документации — это корень данного репозитория
ПОСЛЕ развёртывания в целевом проекте, а не файловая система клона харнесса.

## Build & Test Commands

Источник истины для команд — `.mise/tasks/*`, а не `package.json`: в `package.json`
намеренно отсутствует поле `scripts`.

- **Check**: `mise run check` — typecheck, lint и полный тестовый suite
- **Typecheck**: `mise run typecheck` — `tsc --noEmit`
- **Test**: `mise run test` или `bun test`
- **Single Test**: `bun test test/app/runtime.test.ts` (указать путь или glob)
- **Watch Mode**: `bun test --watch`
- **Lint**: `mise run lint` — ESLint
- **Fix Lint**: `mise run lint-fix` — ESLint с автоисправлением
- **Build**: `mise run build` — runtime, TUI, декларации и JSON schemas в `dist/`
- **Development Build**: `mise run dev` — sourcemaps и vendor splitting
- **Coverage**: `mise run test-coverage`
- **Host Smoke**: `mise run smoke` — проверка упакованного плагина против живого OpenCode
- **Dashboard**: `mise run dashboard` — локальный read-only dashboard

После изменений runtime, public API, схем или build tooling проверяй свежий результат
через `mise run build`; зелёные source-тесты без проверки `dist/` недостаточны.

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
- **TypeScript**: `tsconfig.json` включает strict mode (`strict: true`). Новые изменения
  должны проходить strict typecheck; не ослабляй compiler options локальными исключениями
  без явного обоснования.
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

- Framework: **Vitest API**, запускаемый через `bun test`
- Style: Descriptive nested test cases with clear expectations
- Assertion library: `expect()` (vitest)
- Test layers: unit/domain, app/runtime, e2e/fixtures, TUI, rules и host smoke.
- Не подменяй `bun test` командой `vitest run`: в проекте они не являются
  взаимозаменяемыми по окружению и конфигурации.

## Verification and Delivery Boundaries

- `src/` — исходный код плагина; `dist/` — generated/published artifacts.
- `test/` проверяет поведение в исходном окружении; `scripts/host-smoke/` проверяет
  загрузку и работу собранного плагина в реальном OpenCode host.
- Наличие checkout в `<project>/.opencode/session-guard` само по себе не означает,
  что host загрузил плагин. Проверяй фактическую регистрацию через smoke-сценарий.
- Не выводи в терминал, тестовые отчёты, логи или commit messages секреты, токены,
  содержимое `.env` и приватные MCP-конфигурации.
- Generated artifacts не редактируй вручную, если их можно пересобрать штатной
  командой; после сборки проверяй `git diff -- dist` и отсутствие случайных файлов.

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
- Не записывай в `.memory/` credentials, токены или содержимое приватных конфигураций.

## Маркеры слишком частной реализации (implementation-specific naming)

Плагин должен сохранять обобщённую domain-модель и не добавлять новые публичные API,
завязанные на один workflow-артефакт или конкретную механику OpenCode. Ниже перечислены
legacy-маркеры и рекомендуемые обобщения. Их наличие в существующих runtime-, migration-,
fixture- и test-контрактах само по себе не означает, что их нужно немедленно переименовать.

| Маркер                            | Проблема                                                                                                                                    | Обобщение                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
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

### Правило для новых изменений

Если название поля содержит:

- упоминание конкретного workflow-артефакта (`plan`, `spec`, `bug`, `commit`),
- внутреннюю механику конкретного клиента (`callID`, `sessionID`, `rootSession`),

то это **кандидат на abstraction review**. Для нового публичного поля, guard или метода
нужно выбрать обобщённую модель; существующее поле можно оставить только с явным
обоснованием совместимости или migration scope.

### Требование: полное переписывание, не косметика

Обнаружение маркера означает, что **вся реализация, построенная вокруг него, должна быть переписана**,
а не просто переименована. Недостаточно заменить `planApproved` на `approved` через sed:

- **Данные**: измени структуру session так, чтобы approval не знал о планах (например, очередь approvals вместо pendingPlanApproval)
- **Логика**: перепиши deriveStage, guard-выражения, transition guards так, чтобы они не зависели от `plan.*` и `bug.*` полей
- **API**: публичные методы (approvePlan, declinePlan, markBugVerified) замени на обобщённые (approve, decline, setStageResult)
- **GuardEvaluator**: guard-выражения вида `session.planApproved == true` замени на `granted('plan')`

Критерий для нового API: legacy-маркер не появляется в новом публичном контракте,
guard-выражении или persisted schema без migration-плана. Если выполняется миграция,
изменяй согласованно данные, derive/guard-логику, API, схемы, fixtures и тесты; простая
замена текста через `sed` не считается исправлением.

## Project Context

- **Type**: ES Module OpenCode plugin package with Bun build tooling
- **Target**: Bun runtime, ES2021+, OpenCode plugin API
- **Surfaces**: workflow runtime, session persistence, schema/guards, rules delivery,
  TUI, read-only dashboard и host smoke suite
- **Build output**: `dist/index.js`, `dist/tui.js`, declarations и generated JSON schemas
- **Source of truth**: `tsconfig.json`, `eslint.config.js`, `.prettierrc` и `.mise/tasks/*`
