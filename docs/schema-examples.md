# Примеры schema

Более полный набор примеров вместе с разбором каждого поля — в
[profile-authoring.md](profile-authoring.md).

Примеры ниже показывают содержимое schema в source profile. В target OpenCode-
проекте loader должен получить эту schema через настроенный каталог профилей;
пути `<project>/.opencode/**` относятся к target project, а не к checkout-у
плагина.

## Минимальный линейный workflow

```yaml
gates:
  - id: review

stages:
  planning: {}
  review:
    gates: [review]
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

Ниже приведён фрагмент schema: он предполагает, что стадии `planning` и
`tasks_ready` уже объявлены в основном workflow.

```yaml
transitions:
  - from: planning
    to: tasks_ready
    guard: 'session.refs.plan != null'
    consent: plan
```

`consent` задаёт имя требуемого решения. Его передают в `workflow-consent` через
`type`; перечисленные в запросе файлы становятся evidence и перепроверяются в
момент решения.

## Review и QA

```yaml
gates:
  - id: review
  - id: qa

stages:
  review:
    allowedAgents: [review]
    gates: [review]
  qa:
    allowedAgents: [qa]
    gates: [qa]
  done: {}

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

Проверяйте schema через реальный profile loader и соответствующий тест. В source
repository базовая проверка выполняется через `mise run test` или `mise run check`;
для target project нужен его фактический запуск OpenCode. Пример, который не
проходит загрузку или не имеет достижимой конечной стадии, должен быть помечен
как демонстрация ошибки.
