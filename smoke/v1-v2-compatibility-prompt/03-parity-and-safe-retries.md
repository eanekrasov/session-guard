# V1/V2 parity and safe retries

### 7. Retry и mutating steps

Не допускай безусловного повторного выполнения мутационной инструкции в той же
stateful-сессии.

Введи явную стратегию шага, например:

```ts
type RetryStrategy = 'same-session' | 'new-session' | 'poll-state' | 'none';
```

Каждый `ScenarioStep` обязан явно объявлять:

```ts
interface ScenarioStep {
  instruction: string;
  mutation: 'read-only' | 'mutating';
  retry: RetryStrategy;
  expect: (observation: NormalizedObservation) => true | string;
}
```

Правила:

- после timeout предпочитать `poll-state`, если операция уже могла выполниться;
- mutating steps не повторять в той же сессии без явного разрешения;
- consent, commit, task mutation и subagent dispatch должны иметь безопасную стратегию;
- evidence должен сообщать timeout и повтор;
- retry не должен превращать частично выполненный сценарий в ложный PASS.

Контракт стратегий:

- `none` — после ошибки шаг завершается без повторного prompt;
- `poll-state` — runner не отправляет instruction повторно, а через facade читает
  durable state/operation status до bounded deadline;
- `same-session` — разрешён только для явно read-only/idempotent step;
- `new-session` — создаёт новую изолированную scenario session и повторяет весь
  шаг только когда предыдущая попытка доказанно не оставила durable mutation.

Для timeout mutating step runner обязан сначала получить outcome observation через
facade. Если нельзя доказать, что операция не выполнялась или завершилась, шаг
получает `blocked` с причиной `indeterminate_mutation`; повторная мутация запрещена.
Consent, commit, task mutation и subagent dispatch по умолчанию используют
`poll-state` или `none`, а не `same-session`.

### Состав первого этапа

Первый этап включает только два canonical-сценария: `plugin-loads` и `create`.
Сценарий `no-session` в него не входит и переносится на следующий этап вместе с
остальными сценариями. Поэтому первый этап не должен расширяться до общего
`core`-набора или объявлять `no-session` частью его acceptance.

### Retry policy первого этапа

На первом vertical slice не выполняй общий redesign mutating retries. Для
`plugin-loads` и `create` зафиксируй текущую retry semantics как baseline и
объяви шаги read-only/idempotent либо `retry: none` согласно фактическому
поведению. Новый запрет повторной мутации в той же сессии, `poll-state`,
`indeterminate_mutation` и `new-session` становятся обязательными при миграции
mutation/consent/task/subagent-сценариев.
