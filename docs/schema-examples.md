# Примеры schema

Более полный набор примеров вместе с разбором каждого поля — в
[profile-authoring.md](profile-authoring.md).

## Минимальный линейный workflow

```yaml
stages:
  planning: {}
  review: {}
  done: {}

transitions:
  - from: planning
    to: review
    guard: 'session.refs.plan != null'
  - from: review
    to: done
    guard: "session.gates.review == 'passed'"
```

## Переход с approval

```yaml
transitions:
  - from: planning
    to: tasks_ready
    guard: 'session.refs.plan != null'
    consent: plan
```

## Review и QA

```yaml
stages:
  review:
    allowedAgents: [review]
  qa:
    allowedAgents: [qa]

transitions:
  - from: review
    to: qa
    guard: "session.gates.review == 'passed'"
  - from: qa
    to: done
    guard: "session.gates.qa == 'passed'"
```

## Ошибка schema

```yaml
stages:
  execution:
    dispatch:
      strategy: parallel
```

Этот пример неполный: для `parallel` требуется положительный `maxConcurrent`.
Пример нельзя считать рабочим только потому, что YAML синтаксически корректен.

## Как проверять пример

Проверяйте schema через реальный profile loader и соответствующий тест. Пример,
который не проходит загрузку или не имеет достижимой конечной фазы, должен быть
помечен как демонстрация ошибки.
