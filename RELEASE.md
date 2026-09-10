# Процесс выпуска

Проект использует Release Please и NPM Trusted Publishing для автоматических
выпусков.

Предусмотрены два канала выпуска:

- **Предварительные версии**: обычные PR, объединённые в `main`, создают версии
  `x.x.x-next.J`, которые публикуются под npm-тегом `next` для тестирования и
  сбора обратной связи.
- **Стабильные версии**: PR выпуска, объединённый в `main`, создаёт вычисленную
  версию и публикует её под npm-тегом `latest`.

Публикацию также можно запустить вручную:

- Запустить workflow `publish.yml` на вкладке GitHub Actions и выбрать npm-тег
  `latest` или `next`.
- Локально выполнить `mise run publish --tag latest` или
  `mise run publish --tag next` после аутентификации в npm.

## Первый выпуск

До начала автоматических выпусков необходимо вручную выполнить первый выпуск.

Причины:

- Используется [NPM Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
- Первый выпуск создаёт npm-пакет на npmjs.com.
- После этого для последующих выпусков можно настроить Trusted Publishing через
  GitHub Actions.

### Шаги

1. Убедитесь, что `package.json` настроен корректно:

   - версия в `package.json` указана правильно;
   - имя пакета указано правильно; если требуется scope, он не забыт;
   - указаны нужные keywords;
   - корректно заполнено поле repository;
   - корректно заполнено поле author.

2. Выполните `npm login`, чтобы аутентифицироваться в npm.

3. Выполните `mise run build`, чтобы собрать модуль.

4. Выполните `mise run publish --otp {your-2fa-code}`, чтобы опубликовать первую
   версию.

5. Откройте настройки npm-пакета на npmjs.com и добавьте доверенного издателя для
   GitHub Actions со следующими параметрами:
   - **Организация или пользователь**: имя пользователя или организации GitHub;
   - **Репозиторий**: имя репозитория;
   - **Имя workflow-файла**: `publish.yml` (имя workflow выпуска).

6. Для максимальной безопасности [ограничьте доступ токенов](https://docs.npmjs.com/trusted-publishers#recommended-restrict-token-access-when-using-trusted-publishers).

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
2. Release Please:
   - проанализирует коммиты;
   - определит необходимое изменение версии;
   - обновит `package.json`;
   - обновит `CHANGELOG.md`;
   - создаст PR выпуска.
3. Проверьте и объедините PR выпуска от Release Please.

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

## Запрещено

- вручную редактировать PR от Release Please;
- вручную создавать GitHub Releases;
- напрямую изменять номера версий.

## Публикация

Релизы автоматически публикуются в NPM после объединения PR выпуска от Release
Please.

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

После объединения PR выпуска workflow GitHub Actions автоматически:

1. собирает модуль;
2. публикует его в NPM с OIDC-аутентификацией;
3. создаёт и прикрепляет provenance-attestations;
4. создаёт GitHub Release.

### Ручная публикация

Workflow `publish.yml` поддерживает ручной запуск `workflow_dispatch` с npm-тегом
`latest` или `next`:

```bash
gh workflow run publish.yml --ref main -f tag=latest
```

Workflow собирает пакет и публикует его через npm Trusted Publishing. GitHub
Release при этом не создаётся: GitHub Releases создаёт workflow Release Please.
Для первого локального выпуска выполните `npm login`, затем `mise run build` и
`mise run publish --tag latest --otp {your-2fa-code}`.

Ручная публикация нужна для:

- срочных исправлений вне обычного цикла выпуска;
- публикации предварительной версии под тегом `next`;
- повторной публикации после временного сбоя CI.

**Дополнительная информация:** полное описание настройки и рекомендаций доступно
в [документации NPM Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
