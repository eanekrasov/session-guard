# Процесс выпуска

В репозитории настроены Release Please и публикация через npm Trusted Publishing,
но автоматизация Release Please сейчас отключена: workflow находится в
`.github/workflows/release.yml.disable`, а не в активном каталоге workflow.
Публикацию можно запустить вручную через GitHub Actions или локальную задачу mise.

Для публикации предусмотрены два npm-тега:

- **Предварительные версии**: тег `next`.
- **Стабильные версии**: тег `latest`.

Сами теги не запускают выпуск автоматически. Чтобы включить описанный ниже цикл
Release Please, сначала нужно вернуть workflow выпуска в `.github/workflows/` и
проверить его настройки и секреты.

Публикацию также можно запустить вручную:

- Запустить workflow `publish.yml` на вкладке GitHub Actions и выбрать npm-тег
  `latest` или `next`.
- Локально выполнить `mise run publish --tag latest` или
  `mise run publish --tag next` после аутентификации в npm.

## Локальная публикация

Для GitHub Actions заранее настройте пакет на npmjs.com как доверенного издателя
для этого репозитория и workflow `publish.yml`. Локальная публикация использует
аутентификацию npm.

Для локальной публикации войдите в npm и следуйте текущим требованиям
аутентификации для своего аккаунта. Правила npm могут меняться; ссылки на
официальную документацию приведены ниже.

Перед публикацией проверьте, что `package.json` настроен корректно:

- для `latest` вручную установите нужную версию в `package.json` и обновите
  `CHANGELOG.md`: workflow Release Please сейчас выключен;
- для `next` задача `mise run publish --tag next` формирует версию предварительного
  выпуска и публикует её под тегом `next`;
- имя пакета указано правильно; если требуется scope, он не забыт;
- указаны нужные keywords;
- корректно заполнено поле repository;
- корректно заполнено поле author.

1. Выполните `npm login`, чтобы аутентифицироваться в npm.
2. Запустите `mise run publish --tag latest` или `mise run publish --tag next`.

Задача сама запускает сборку перед публикацией. Для публикации через GitHub
Actions пакет должен быть заранее настроен на npmjs.com как доверенный издатель
для этого репозитория и workflow `publish.yml`.

## Workflow выпуска

### Conventional Commits

Мы следуем спецификации [Conventional Commits](https://www.conventionalcommits.org/):

- `fix:` — исправления;
- `feat:` — новые возможности;
- `feat!:` или `fix!:` — обратно несовместимые изменения.

### Версионирование до версии 1.0

Пока версия имеет формат `0.x.x`, обратно несовместимые изменения увеличивают
minor-версию.

### Процесс выпуска

1. Отправьте коммиты в ветку `main`.
2. При активном workflow Release Please:
   - проанализирует коммиты;
   - определит необходимое изменение версии;
   - обновит `package.json`;
   - обновит `CHANGELOG.md`;
   - создаст PR выпуска.

Этот автоматический шаг сейчас не выполняется: `.github/workflows/release.yml.disable`
не запускается GitHub Actions. Конфигурация в `release-please-config.json` сама по
себе workflow не активирует. Следующие разделы о Release Please — справочная
информация на случай повторного включения этого workflow, а не инструкции для
текущего выпуска.

### Примеры сообщений коммитов

- `fix: resolve task tracking issue`
- `feat: add global task support`
- `feat!: change task management API`
- `docs: improve README`
- `chore: update dependencies`

## Расширенные возможности выпуска

### Принудительно задать версию

Используйте footer `Release-As` в сообщении коммита, чтобы принудительно задать
версию и обойти анализ Conventional Commits:

```bash
git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"
```

Такой коммит выглядит следующим образом:

```
chore: release 2.0.0

Release-As: 2.0.0
```

Release Please создаст PR для версии `2.0.0` независимо от типов сообщений
коммитов.

### Обновлять дополнительные файлы при выпуске

Если номера версий находятся не только в `package.json`, настройте эти файлы в
`release-please-config.json`:

```json
{
  "extra-files": [
    "src/version.ts",
    {
      "type": "generic",
      "path": "docs/VERSION.md"
    },
    {
      "type": "yaml",
      "path": ".tool-versions",
      "jsonpath": "$.node"
    }
  ]
}
```

**Поддерживаемые типы файлов:**

- generic-файлы (любой тип);
- JSON-файлы (с JSONPath);
- YAML-файлы (с JSONPath);
- XML-файлы (с XPath);
- TOML-файлы (с JSONPath).

### Специальные комментарии для маркеров версии

Используйте встроенные комментарии, чтобы отметить места, где Release Please
должен обновить версии:

```javascript
// x-release-please-version
const VERSION = '1.0.0';

// x-release-please-major
const MAJOR = '1';
```

Или используйте блочные маркеры:

```markdown
<!-- x-release-please-start-version -->

- Current version: 1.0.0

<!-- x-release-please-end -->
```

Доступные маркеры:

- `x-release-please-version` — полная semver-версия;
- `x-release-please-major` — номер major-версии;
- `x-release-please-minor` — номер minor-версии;
- `x-release-please-patch` — номер patch-версии.

## Запрещено при активном Release Please

- вручную редактировать PR от Release Please;
- вручную создавать GitHub Releases;
- напрямую изменять номера версий.

## Публикация

Публикация выполняется активным workflow `publish.yml` по событию `workflow_dispatch`
или `repository_dispatch`. Последнее сейчас не отправляется автоматически:
создание release PR и отправка `repository_dispatch` описаны в отключённом
`.github/workflows/release.yml.disable`.

### Аутентификация npm

Требования к 2FA и токенам зависят от текущей политики npm и настроек аккаунта.
Для локального выпуска выполните `npm login`; если npm запрашивает одноразовый код,
задача `mise run publish` принимает его через `--otp`. Перед выпуском сверяйтесь с
[актуальной документацией npm по 2FA](https://docs.npmjs.com/about-two-factor-authentication)
и [настройке 2FA](https://docs.npmjs.com/configuring-two-factor-authentication).

### NPM Trusted Publishing

Проект использует [NPM Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
через GitHub Actions. npm-токены не нужны: аутентификация выполняется
автоматически через OIDC (OpenID Connect).

**Как это работает:**

- каждая публикация использует краткоживущие криптографически подписанные
  токены, предназначенные для конкретного workflow;
- токены нельзя извлечь или использовать повторно;
- не нужно управлять долгоживущими учётными данными или ротировать их;
- автоматические provenance-attestations подтверждают, где и как был собран
  пакет.

**Необходимая настройка:**

1. Откройте настройки npm-пакета на npmjs.com.
2. Добавьте доверенного издателя для GitHub Actions со следующими параметрами:
   - **Организация или пользователь**: имя пользователя или организации GitHub;
   - **Репозиторий**: имя репозитория;
   - **Имя workflow-файла**: `publish.yml` (имя workflow выпуска).
3. При необходимости [ограничьте доступ токенов](https://docs.npmjs.com/trusted-publishers#recommended-restrict-token-access-when-using-trusted-publishers) для максимальной безопасности.

При запуске активного `publish.yml` GitHub Actions:

1. собирает модуль;
2. публикует его в NPM с OIDC-аутентификацией;
3. создаёт и прикрепляет provenance-attestations;
4. не создаёт GitHub Release. Создание релиза было частью отключённого workflow Release Please.

### Ручная публикация

Workflow `publish.yml` поддерживает ручной запуск `workflow_dispatch` с npm-тегом
`latest` или `next`:

```bash
gh workflow run publish.yml --ref main -f tag=latest
```

Workflow собирает пакет и публикует его через npm Trusted Publishing. GitHub
Release при этом не создаётся.
Для локального выпуска выполните `npm login`, затем
`mise run publish --tag latest`. Задача сама запускает сборку; при необходимости
одноразовый код можно передать через `--otp`.

Ручная публикация нужна для:

- срочных исправлений вне обычного цикла выпуска;
- публикации предварительной версии под тегом `next`;
- повторной публикации после временного сбоя CI.

**Дополнительная информация:** полное описание настройки и рекомендаций доступно
в [документации NPM Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
