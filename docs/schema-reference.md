# Справочник workflow schema

Schema описывает пользовательскую траекторию workflow в YAML. Полный пример
находится в [schema-examples.md](schema-examples.md), пошаговое написание — в
[schema-writing-guide.md](schema-writing-guide.md).

## Верхний уровень

| Раздел | Назначение |
|---|---|
| `extends` | Наследование другой schema |
| `phases` | Фазы и их параметры |
| `transitions` | Допустимые переходы между фазами |
| `gates` | Проверки workflow |
| `tools` | Дополнительные workflow tools |
| `gateMapping` | Связь действий с gates |
| `actionGuards` | Условия допуска действий |
| `editingAgents` | Агенты, которым разрешено редактирование |
| `verifiers` | Агенты проверки |
| `requiredGates` | Обязательные gates |
| `settings` | Дополнительные настройки профиля |

Все разделы опциональны на уровне parser, но итоговый workflow должен иметь
достижимые фазы и переходы.

## Фазы

```yaml
phases:
  planning:
    allowedAgents: [architect]
  review:
    allowedAgents: [review]
```

Фаза может содержать `allowedAgents`, `entryGuards`, `exitGuards`, `stages`,
`loop`, `dispatch`, `retryBudget` и `exitGuards`.

## Переходы

```yaml
transitions:
  - from: planning
    to: review
    guard: "session.refs.plan != null"
    consent: plan
```

Поддерживаются `from`, `to`, необязательные `guard`, `kind` (`auto`, `pass`,
`fail`), `effects`, `consent` и `onFailure` (`retry` или `terminal`).

## Dispatch и cycles

`dispatch.strategy` принимает `serial`, `parallel` или
`serial_with_overlap`. Для parallel-режимов требуется положительный
`maxConcurrent`. `loop` указывает статический список либо `$currentTask.id`.

## Ограничения

- ID задачи должны иметь формат `task-<number>`.
- ID задач уникальны между списками.
- Нельзя использовать один и тот же статический loop source в нескольких фазах.
- Недопустимые значения и ошибки schema должны быть показаны пользователю до
  запуска workflow.
