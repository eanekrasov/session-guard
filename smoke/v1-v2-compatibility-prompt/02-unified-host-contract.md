# Unified host contract

## Текущая проблема

Сейчас V1 и V2 используют разные host-контракты.

### V1

- ручные HTTP endpoint-ы;
- `POST /session`;
- `POST /session/{id}/message`;
- `GET /question`;
- `POST /question/{id}/reply`;
- agent передаётся в каждом сообщении;
- plugin подключается через `plugin: ["file://..."]`.

### V2

- `@opencode/client`;
- `session.create`;
- `session.prompt`;
- SSE terminal events (`session.execution.*`);
- `session.form.list`;
- `session.form.reply`;
- `session.switchAgent`;
- plugin подключается через `plugins: [{ package: "..." }]`;
- host может требовать Basic Auth;
- forms и вопросы представлены иначе.

Из-за этого сейчас:

- V1 и V2 имеют отдельные scenario runner-ы и разные типы состояния;
- V2 не поддерживает весь набор настроек сценария V1;
- V2 запускается только с profile `smoke`;
- V2 не принимает per-scenario `env` и `files`;
- retry-семантика различается;
- assertions зависят от V1/V2 формы сообщений;
- V1 и V2 не имеют полностью единого результата.

## Цель

Сделать один набор сценариев, работающий через один фасад:

- `SmokeHost`/`HostSession` — единый интерфейс для сценариев;
- внутренняя V1 transport strategy на Legacy HTTP API;
- внутренняя V2 transport strategy на `@opencode/client`.

Сценарии и runner зависят только от единого smoke-контракта. Две transport
strategies существуют только внутри фасада, transport layer и host-конфигуратора.

Если read-only анализ обнаружит, что plugin сам отдаёт V1/V2-разные semantics или
result shapes, сначала проверь возможность исправить это в production plugin через
общий внутренний/public contract. Не протаскивай plugin logic в smoke adapter.
Если plugin contract остаётся разным по объективной причине host API, различие
должно быть нормализовано в `SmokeHost`, а не в сценариях.

## Обязательные требования

### 1. Один общий host-контракт для сценариев

Введи один внутренний интерфейс `SmokeHost` для сценариев, например:

```ts
interface SmokeHost {
  readonly kind: 'v1' | 'v2';
  createSession(title: string): Promise<SmokeSession>;
  runPrompt(session: SmokeSession, input: PromptInput): Promise<PromptResult>;
  readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>;
  closeSession(session: SmokeSession): Promise<void>;
}
```

`PromptInput`, `PromptResult`, `SmokeSession` и `SmokeWorkflowState` — локальные
normalized smoke-типы. Их состав определяется общей спецификацией в
`06-scenario-contract-and-registry.md`; V1/V2-specific operations остаются
внутри фасада и его transport strategies.

Название и состав можно изменить, если итоговый дизайн лучше, но обязательно:

- сценарии и общий runner не знают V1 endpoint-ы;
- сценарии и общий runner не знают generated V2 client;
- сценарии и общий runner не знают Basic Auth;
- сценарии и общий runner не знают, используется `question` или `form`;
- сценарии и общий runner не знают, передаётся agent в message или через session switch;
- сценарии импортируют только общий `SmokeHost` и нормализованные типы;
- V1/V2 transport-specific детали остаются внутри фасада и его внутренних strategies.

Это внутренний API smoke-suite, не публичный API production plugin. Не создавай
два разных интерфейса для сценариев, например `V1Host` и `V2Host`.

### 2. Общие нормализованные типы

Введи типы для результата host-операции, например:

```ts
interface NormalizedTurn {
  status: 'completed' | 'timed-out' | 'failed' | 'unknown';
  transcript: string;
  parts: NormalizedPart[];
  toolCalls: NormalizedToolCall[];
  pendingInteraction?: boolean;
}

interface NormalizedPart {
  kind: 'text' | 'tool' | 'error' | 'unknown';
  tool?: string;
  text?: string;
  output?: string;
  error?: string;
}

interface NormalizedForm {
  id: string;
  fields: NormalizedFormField[];
}

interface NormalizedFormField {
  key: string;
  type: 'choice' | 'multiselect' | 'boolean' | 'text' | 'unknown';
  title?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string | number | boolean;
}
```

Не копируй V1/V2 shapes механически. Преобразуй их в общие типы внутри внутренних
transport strategies единого `SmokeHost`.

Новые или изменённые plugin types должны переиспользовать существующие типы
production plugin. Перед созданием нового DTO проверь `src/`, схемы и тесты на
уже существующий контракт. Не создавай smoke-only копию plugin domain model.

Это правило относится к production plugin types, если меняется сам plugin. Оно
НЕ разрешает smoke импортировать эти типы. Smoke остаётся изолированным и должен
иметь собственные normalized types в `smoke/`.

Недопустимо:

```ts
import type { WorkflowSession } from '../../src/session/session-types.ts';
import type { ToolResult } from '../../src/app/tool-api.ts';
```

Также не импортируй типы из `dist/`: это всё равно создаёт compile-time coupling
к plugin package вместо проверки его поведения через host.

Допустимо:

```ts
// smoke/src/host/types.ts
export interface SmokeSession {
  id: string;
}

export interface SmokeWorkflowState {
  currentStage?: string;
  tasks?: Record<string, Array<{ status?: string }>>;
}
```

Перед созданием нового smoke-типа сначала проверь типы внутри `smoke/`. Не
дублируй V1/V2 shapes: общие normalized types должны жить в одном общем smoke
модуле и использоваться обеими strategies.
