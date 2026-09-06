# Справочник workflow schema

Schema описывает пользовательскую траекторию workflow в YAML. Полный пример
находится в [schema-examples.md](schema-examples.md), пошаговое написание — в
[schema-writing-guide.md](schema-writing-guide.md).

## Верхний уровень

| Раздел          | Назначение                               |
| --------------- | ---------------------------------------- |
| `extends`       | Наследование другой schema               |
| `stages`        | Фазы и их параметры                      |
| `transitions`   | Допустимые переходы между фазами         |
| `gates`         | Проверки workflow                        |
| `tools`         | Дополнительные workflow tools            |
| `gateMapping`   | Связь действий с gates                   |
| `actionGuards`  | Условия допуска действий                 |
| `editingAgents` | Агенты, которым разрешено редактирование |
| `verifiers`     | Агенты проверки                          |
| `requiredGates` | Обязательные gates                       |
| `settings`      | Дополнительные настройки профиля         |

Все разделы опциональны на уровне parser, но итоговый workflow должен иметь
достижимые фазы и переходы.

## Фазы

```yaml
stages:
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
    guard: 'session.refs.plan != null'
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

## Scope задачи (`readScope` / `writeScope`)

Каждая `MutationTask` может объявить `readScope: string[]` и
`writeScope: string[]` — независимые друг от друга glob-маски (одна не
выводится из другой). Поля `path`, `manifest` и `declaredScope` удалены без
замены.

- `readScope` — это **фокус**, а не граница конфиденциальности: он определяет,
  какие файлы релевантны задаче, а не какие файлы агенту вообще запрещено
  когда-либо узнать. Канал `edit`/`old_string` и `InvariantViolation.message`
  остаются открытыми по дизайну.
- Отсутствующий или пустой `writeScope` означает задачу только для чтения:
  любая запись отклоняется, и такая задача не пересекается ни с чем при
  параллельном допуске.
- `writeScope` проверяется до выполнения для `write`/`edit`/`apply_patch`
  (путь `apply_patch` разбирается из `patchText`). Для `bash` проверка до
  выполнения невозможна — у вызова нет аргумента-пути, только `workdir`; факт
  выхода за пределы `writeScope` виден только постфактум, через diff
  per-move baseline.

### Ловушка «голой директории»

Маска без `/**` не совпадает ни с чем внутри директории:

```
writeScope: ['src/auth']        # НЕ совпадает с src/auth/login.ts
writeScope: ['src/auth/**']     # совпадает с src/auth/login.ts
```

Совпадение якорится с обеих сторон (`'/' + path.replace(/^\/+/, '')`), поэтому
маска без `/` в начале не может неявно совпасть с basename в произвольном
месте дерева: `*.ts` совпадает с `x.ts`, но не с `deep/nested/x.ts`.

### Консервативное пересечение масок при параллельном допуске (D4)

Для параллельного dispatch новая задача отклоняется, если её `writeScope`
пересекается с `writeScope` любой уже выполняющейся задачи. Пересечение
масок определяется консервативно (по сегментам пути), с фиксированным
направлением ошибки: ложное пересечение — приемлемо, ложное отсутствие
пересечения — нет. Из-за этого следующие допустимые (фактически
непересекающиеся) пары масок будут ошибочно признаны пересекающимися:

- `src/*.ts` и `src/*.tsx`
- `src/**/*.test.ts` и `src/**/*.impl.ts`
- `src/{a,b}/**` и `src/c/**`
- любая пара, различающаяся только внутри wildcard-сегмента

Отрицание (`!…`) в масках не поддерживается и отклоняется на этапе
валидации schema, а не сравнивается неверно.
