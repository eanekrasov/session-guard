/**
 * Host harness — запускает реальный opencode во временном проекте.
 *
 * Всё, чем управляет плагин, ведётся через хост: настоящие
 * `opencode serve`, настоящая сессия, настоящая модель, настоящий конвейер инструментов.
 * Никакой код здесь не проникает во внутренности плагина; проверки читают
 * состояние сессии, сохранённое плагином, в точности как это делал бы оператор.
 *
 * Изоляция: XDG config/data/state/cache указывают на временное дерево, поэтому
 * агенты, плагины и сессии оператора не участвуют. Учётные данные провайдера
 * из `auth.json` копируются — именно они делают модель живой.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsmin } from 'jsmin';
import { configuredLogLevel, log } from './log.ts';
export { configuredLogLevel, log, type LogLevel } from './log.ts';

export const REPO_ROOT = resolve(import.meta.dir!, '../..');

/**
 * Канонические пути к бинарникам opencode. V1 — по умолчанию; V2 доступен
 * при явном выборе. Никогда не откатываться к /opt/homebrew/bin/opencode.
 *
 * Эти пути должны существовать во время выполнения, иначе harness завершится ошибкой.
 */
export const V1_BINARY = '/opt/homebrew/opt/opencode/bin/opencode';
export const V2_BINARY = '/opt/homebrew/opt/opencode-v2/bin/opencode';

const DEFAULT_ATTEMPTS = 3;

export type HostVersion = 'v1' | 'v2';

/** Разобрать явный выбор хоста без скрытого изменения контрактов хоста. */
export function hostVersionFromEnv(value = process.env.HOST_SMOKE_OPENCODE_VERSION): HostVersion {
  if (value === undefined || value === '') return 'v1';
  if (value === 'v1' || value === 'v2') return value;
  throw new Error(`Недопустимое HOST_SMOKE_OPENCODE_VERSION=${value}; ожидается «v1» или «v2».`);
}

/** Определить путь к бинарнику для запрошенной версии. */
export function opencodeBinary(
  version: HostVersion,
  env: Record<string, string | undefined> = process.env
): string {
  const variable = version === 'v2' ? 'HOST_SMOKE_V2_BINARY' : 'HOST_SMOKE_V1_BINARY';
  return env[variable] || (version === 'v2' ? V2_BINARY : V1_BINARY);
}

/** Разрешить число повторов шага, сообщая о непригодном значении окружения. */
export function attemptsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HOST_SMOKE_ATTEMPTS;
  if (raw === undefined) return DEFAULT_ATTEMPTS;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  log('warn', `Недопустимое HOST_SMOKE_ATTEMPTS=${raw}; используется ${DEFAULT_ATTEMPTS}.`);
  return DEFAULT_ATTEMPTS;
}

/**
 * Живая среда не может предоставить хост: нет бинарника, не разрешается модель, процесс
 * сервера не поднялся. Caller сообщает это как `not-run` с `live-environment-unavailable`
 * и не считает такой запуск находкой о сценарии.
 *
 * Любая другая ошибка bootstrap (запись конфигурации, фикстура профиля, сборка плагина)
 * остаётся обычной ошибкой и завершает прогон фатально: значит, сломан harness или
 * плагин, а не отсутствует среда.
 */
export class EnvironmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentUnavailableError';
  }
}

/** Проверить бинарник непосредственно перед запуском дочернего хоста. */
export function ensureOpencodeBinary(version: HostVersion, env = process.env): string {
  const variable = version === 'v2' ? 'HOST_SMOKE_V2_BINARY' : 'HOST_SMOKE_V1_BINARY';
  const binary = opencodeBinary(version, env);
  if (!existsSync(binary)) {
    throw new EnvironmentUnavailableError(
      `[ERROR] бинарник opencode ${version} не найден по пути ${binary}; задайте ${variable}, чтобы переопределить путь.`
    );
  }
  return binary;
}

/** Учётные данные, которые хост V2 сгенерировал для себя, как объявлено в его логе. */
export function serverPasswordFromLogs(logs: string): string | null {
  return /server password\s+(\S+)/.exec(logs)?.[1] ?? null;
}

/** Значение `Authorization`, которое хост V2 принимает для этих учётных данных. */
export function basicAuthHeader(password: string, user = 'opencode'): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Прочитать сгенерированный пароль из лога, как только он появится, или отказаться. */
async function waitForServerPassword(
  read: () => string,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const password = serverPasswordFromLogs(read());
    if (password) return password;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface Host {
  /** Базовый URL запущенного сервера opencode. */
  url: string; /** Директория временного проекта, в которой был запущен opencode. */
  workDir: string;
  /** Всё, что записал хост — конфиг, данные, сессии. */
  homeDir: string;
  /**
   * Значение `Authorization`, которое API этого хоста принимает, когда оно нужно.
   *
   * V1 не требует. V2 игнорирует `OPENCODE_SERVER_PASSWORD`, генерирует свои
   * учётные данные и требует их при каждом вызове `/api`.
   */
  authHeader?: string;
  stop: () => Promise<void>;
  /** stdout+stderr сервера для диагностики сценария, который не выполнился. */
  logs: () => string;
}

/**
 * Кеш изолированного хоста.
 *
 * Хост на старте добирает в кеш свои зависимости и без прогретого кеша делает это в сеть при
 * каждом запуске, задерживая первую сессию. Кеш не содержит состояния прогона и не является
 * секретом, поэтому он живёт в `.memory/` (каталог исключён из Git) и переиспользуется между
 * прогонами: первый старт его наполняет, последующие читают. Каталоги данных и состояния при
 * этом остаются одноразовыми — сессии, плагинные артефакты и база не протекают между прогонами.
 */
/**
 * Свободный локальный порт для хоста.
 *
 * `--port 0` в этом билде opencode означает не «любой свободный», а порт по умолчанию (4096):
 * два прогона подряд или осиротевший после убийства хоста процесс начинают отвечать чужой
 * сессией, и smoke-клиент ждёт хост, который занят другим прогоном. Поэтому порт выбираем сами.
 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

/**
 * Кеш npm для установки зависимостей плагина в изолированном хосте.
 *
 * Живёт рядом с кешем хоста, вне одноразового дерева прогона: первый старт наполняет его,
 * последующие читают, и установка перестаёт ходить в сеть на каждом запуске.
 */
/**
 * Каталог конфигурации изолированного хоста.
 *
 * Рядом с конфигом хост ставит зависимости, нужные для загрузки плагинов
 * (`<config>/opencode/node_modules`, около 60 МБ). Каталог конфигурации одноразовым не делаем:
 * иначе эти зависимости скачиваются заново на каждом старте и задерживают первую сессию.
 * Сами конфигурационные файлы прогон перезаписывает, поэтому чужого состояния здесь нет.
 */
export function smokeConfigDir(): string {
  return join(REPO_ROOT, '.memory', 'opencode-config');
}

export function smokeNpmCacheDir(): string {
  return join(REPO_ROOT, '.memory', 'opencode-npm-cache');
}

export function smokeCacheDir(): string {
  return join(REPO_ROOT, '.memory', 'opencode-cache');
}

export interface HostOptions {
  /** Идентификатор модели, например `crpt/qwen-coder-x`. По умолчанию $HOST_SMOKE_MODEL. */
  model: string;
  /** Директория профиля (внутри `profiles/`), который нужно поместить в проект. */
  profile: string;
  /** Версия хоста OpenCode для запуска. По умолчанию 'v1'. */
  version?: HostVersion;
  /** Дополнительные файлы для записи в проект, путь → содержимое. */
  files?: Record<string, string>;
  /** Нужно ли выполнить `git init` в проекте и сделать seed-коммит. */
  git?: boolean;
  /** Дополнительное окружение для процесса хоста. */
  env?: Record<string, string>;
}

/**
 * Окружение, которое наследует изолированный хост.
 *
 * Операторская конфигурация и её переключатели приезжают в прогон вместе с окружением: хост
 * умеет читать конфиг по явному пути (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`), а его bootstrap
 * ставит из npm плагины, объявленные в чужом конфиге, и загружает их в прогон — изоляция
 * заканчивается, и старт каждой сессии уходит в сеть на минуты. Поэтому всё, что относится к
 * OpenCode и OpenChamber, из наследства вырезается целиком, а нужные прогону значения harness
 * выставляет сам. Остальное окружение сохраняется: PATH, сертификаты, прокси модели и ключи
 * провайдера, на которые ссылается конфиг, — без них не будет живой модели.
 */
export function isolatedEnvironment(
  base: Record<string, string | undefined>
): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith('OPENCODE_') || name.startsWith('OPENCHAMBER_')) continue;
    inherited[name] = value;
  }
  return inherited;
}

/** Максимальное количество байт для одного поля trace payload до усечения. */
const TRACE_PAYLOAD_MAX = 4096;

/**
 * Замаскировать типовые шаблоны секретов (api keys, tokens, passwords) в строке.
 * Заменяет значение секрета на `<REDACTED>`, оставляя окружающую структуру
 * нетронутой, чтобы форма была по-прежнему читаема.
 */
export function redactSecrets(text: string): string {
  return text.replace(
    /(api[_-]?key|token|password|secret|auth|credential)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-.]{16,}/gi,
    '$1=<REDACTED>'
  );
}

/**
 * Усечь строку до `max` байт, добавляя маркер усечения, если строка обрезана.
 * Предпочтительно обрезать по границе слова, когда это возможно.
 */
export function truncatePayload(text: string, max = TRACE_PAYLOAD_MAX): string {
  if (Buffer.byteLength(text, 'utf-8') <= max) return text;
  let truncated = text.slice(0, max);
  // Попробовать обрезать по границе слова
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > max * 0.75) truncated = truncated.slice(0, lastSpace);
  return `${truncated} …[truncated ${Buffer.byteLength(text, 'utf-8') - Buffer.byteLength(truncated, 'utf-8')} bytes]`;
}

/**
 * Безопасно усечь и замаскировать поле trace payload.
 */
export function sanitizeTracePayload(value: string): string {
  return truncatePayload(redactSecrets(value));
}

const activeHostStops = new Set<() => Promise<void>>();
const packDirectories = new Set<string>();
let requestSequence = 0;
const requestCounts = new Map<string, number>();
const requestStartedAt = new Map<string, number>();

process.once('exit', () => {
  for (const directory of packDirectories) rmSync(directory, { recursive: true, force: true });
});

/** Остановить хосты, которые работают или всё ещё ждут свой listen URL. */
export async function stopAllHosts(): Promise<void> {
  log('debug', `останавливаются активные хосты: ${activeHostStops.size}`);
  await Promise.allSettled([...activeHostStops].map((stop) => stop()));
  log('debug', 'все активные хосты остановлены');
}

function run(cmd: string, args: string[], cwd: string): string {
  log('debug', `запуск ${cmd} ${args.join(' ')} (cwd=${cwd})`);
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    log('error', `${cmd} завершился со статусом ${result.status ?? 'signal'}`);
    throw new Error(
      `${cmd} ${args.join(' ')} завершился с ошибкой: ${result.stderr || result.stdout}`
    );
  }
  log('debug', `${cmd} успешно завершён`);
  return (result.stdout ?? '').trim();
}

/**
 * Собрать плагин и передать хосту директорию собранной точки входа.
 *
 * Это та же форма spec, которую оператор указывает в своей конфигурации opencode
 * (`file://<...>/dist`), поэтому прогон загружает плагин так же, как настоящая установка.
 * Упакованный `.tgz` *не* используется: хост не загружает его из spec `file://`,
 * что само по себе полезно знать, прежде чем кто-либо начнёт поставлять плагин таким образом.
 *
 * Сборка идёт **без** зависимостей задачи (`--skip-deps`): сама `build` ничего не ставит, а её
 * зависимость `setup` выполняет `hk install` и `bun install` — то есть каждый прогон заново
 * ходил бы в реестр за пакетами, которые уже лежат в `node_modules`. На чистом checkout-е
 * сборка тогда падает заметно (нет зависимостей), а не подтягивает их молча.
 */
export function buildPlugin(): string {
  log('info', 'сборка плагина для host smoke');
  run('mise', ['run', '--skip-deps', 'build'], REPO_ROOT);
  const pluginPath = join(REPO_ROOT, 'dist');
  log('info', `собранный плагин готов: ${pluginPath}`);
  return pluginPath;
}

/** Собрать и упаковать плагин в tarball. Сохранён для проверок упаковки. */
export function packPlugin(): string {
  // Тот же запрет на установку зависимостей, что и у `buildPlugin`: пакеты уже на месте,
  // а `setup` в реестр ходить не должен.
  run('mise', ['run', '--skip-deps', 'build'], REPO_ROOT);
  const destination = mkdtempSync(join(tmpdir(), 'host-smoke-pack-'));
  try {
    const out = run('bun', ['pm', 'pack', '--destination', destination], REPO_ROOT);
    // `bun pm pack` выводит список файлов и сводку; путь к tarball — это строка,
    // которая заканчивается на .tgz и стоит отдельно.
    const line = out
      .split('\n')
      .map((entry) => entry.trim())
      .findLast((entry) => entry.endsWith('.tgz') && !entry.startsWith('packed'));
    if (!line) throw new Error(`не удалось прочитать упакованный tarball из:\n${out}`);
    packDirectories.add(destination);
    return line.startsWith('/') ? line : join(destination, line);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Удалить завершающие запятые после того, как jsmin удалил комментарии JSONC. */
function removeTrailingCommas(text: string): string {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && inString) {
      out.push(ch, text[++i] ?? '');
      continue;
    }
    if (ch === '"') inString = !inString;
    if (ch === ',' && !inString && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out.push(ch);
  }
  return out.join('');
}

/** Разобрать JSONC, используя то же поведение jsmin, что и загрузчик провайдеров V1. */
function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(removeTrailingCommas(jsmin(text))) as T;
}

function resolveProviderKeys(provider: unknown): unknown {
  if (typeof provider !== 'object' || provider === null) return provider;
  for (const entry of Object.values(provider as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const options = (entry as { options?: Record<string, unknown> }).options;
    const key = options?.apiKey;
    const match = typeof key === 'string' ? /^\{env:([A-Z0-9_]+)\}$/.exec(key) : null;
    if (match && !process.env[match[1]!]) delete options!.apiKey;
  }
  return provider;
}

function providerContainsModel(providerName: string, provider: unknown, model: string): boolean {
  if (typeof provider !== 'object' || provider === null) return false;
  const models = (provider as { models?: unknown }).models;
  if (typeof models !== 'object' || models === null) return false;
  const [modelProvider, ...modelID] = model.split('/');
  if (!modelProvider || modelID.length === 0 || modelProvider !== providerName) return false;
  return (
    Object.prototype.hasOwnProperty.call(models, modelID.join('/')) ||
    Object.prototype.hasOwnProperty.call(models, modelID.at(-1)!)
  );
}

export function filterProviders(providers: unknown, model: string): unknown {
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers))
    return providers;
  return Object.fromEntries(
    Object.entries(providers as Record<string, unknown>).filter(([name, provider]) =>
      providerContainsModel(name, provider, model)
    )
  );
}

export function filterOperatorProviders(
  operator: { provider?: unknown; providers?: unknown },
  model: string
): { provider?: unknown; providers?: unknown } {
  return {
    ...(operator.provider ? { provider: filterProviders(operator.provider, model) } : {}),
    ...(operator.providers ? { providers: filterProviders(operator.providers, model) } : {}),
  };
}

/**
 * Ключ провайдера, который хост V2 больше не может импортировать самостоятельно.
 *
 * Свежая директория данных V2 никогда не выполняет импорт устаревших учётных данных:
 * загрузчик базы данных создаёт текущую схему и помечает **каждую** миграцию
 * как применённую, не выполняя ни одну из них
 * (`packages/core/src/database/migration.ts`), поэтому таблица `credential`
 * остаётся пустой, и `20260805200742_import_legacy_credentials` ничего не импортирует. Без
 * учётных данных резолвер модели принудительно выставляет `auth: none`, и каждый промпт
 * завершается ошибкой `provider.auth` — именно это V2 smoke сообщал как мёртвую модель.
 *
 * V1 читает `auth.json` напрямую, поэтому это нужно только для V2.
 */
export function legacyApiKeyFor(
  providerID: string,
  authFile = join(homedir(), '.local/share/opencode/auth.json')
): string | undefined {
  if (!existsSync(authFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(authFile, 'utf-8')) as Record<string, unknown>;
    const entry = parsed[providerID] as { type?: unknown; key?: unknown } | undefined;
    return entry?.type === 'api' && typeof entry.key === 'string' && entry.key !== ''
      ? entry.key
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Поместить этот ключ туда, где запись провайдера V2 хранит конфигурацию. Запись,
 * в которой оператор уже указал ключ, остаётся без изменений.
 */
export function withProviderApiKey(providers: unknown, model: string, authFile?: string): unknown {
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return providers;
  }
  const providerID = model.split('/')[0] ?? '';
  const key =
    authFile === undefined ? legacyApiKeyFor(providerID) : legacyApiKeyFor(providerID, authFile);
  if (!key) return providers;

  const map = providers as Record<string, unknown>;
  const entry = map[providerID];
  if (typeof entry !== 'object' || entry === null) return providers;

  const settings = (entry as { settings?: unknown }).settings;
  const existing =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).apiKey
      : undefined;
  if (typeof existing === 'string' && existing !== '') return providers;

  log('debug', `ключ провайдера ${providerID} настроен из базы учётных данных оператора`);
  return {
    ...map,
    [providerID]: {
      ...(entry as Record<string, unknown>),
      settings: {
        ...(typeof settings === 'object' && settings !== null ? settings : {}),
        apiKey: key,
      },
    },
  };
}

export async function operatorProviders(requestedModel?: string): Promise<{
  provider?: unknown;
  providers?: unknown;
  disabled_providers?: unknown;
  model?: string;
}> {
  const configHome =
    process.env.HOST_SMOKE_OPERATOR_CONFIG ?? join(homedir(), '.config', 'opencode');
  const merged: {
    provider?: unknown;
    providers?: unknown;
    disabled_providers?: unknown;
    model?: string;
  } = {};
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = join(configHome, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = name.endsWith('.jsonc')
        ? parseJsonc<Record<string, unknown>>(await readFile(file, 'utf-8'))
        : (JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>);
      if (parsed.provider) merged.provider = resolveProviderKeys(parsed.provider);
      if (parsed.providers) merged.providers = resolveProviderKeys(parsed.providers);
      if (parsed.disabled_providers) merged.disabled_providers = parsed.disabled_providers;
      if (typeof parsed.model === 'string') merged.model = parsed.model;
    } catch {
      // Некорректная или нечитаемая опциональная конфигурация игнорируется, сохраняя поведение V1.
    }
  }
  const model = requestedModel ?? merged.model;
  if (model) Object.assign(merged, filterOperatorProviders(merged, model));
  return merged;
}

/** Модель, которую оператор использует по умолчанию, для случаев, когда модель не задана. */
export async function defaultModel(_binary?: string): Promise<string> {
  const fromEnv = process.env.HOST_SMOKE_MODEL;
  if (fromEnv) {
    log('debug', `модель из HOST_SMOKE_MODEL: ${fromEnv}`);
    return fromEnv;
  }
  const operator = await operatorProviders();
  const model = operator.model;
  if (!model) {
    log('error', 'разрешённая конфигурация opencode не содержит модель');
    throw new EnvironmentUnavailableError(
      '[ERROR] Нет модели для запуска: задайте HOST_SMOKE_MODEL или объявите `model` в конфигурации opencode.'
    );
  }
  log('info', `модель из разрешённой конфигурации opencode: ${model}`);
  return model;
}

/**
 * Сохранён только для диагностики. Вывод V2 — это исходные документы, а не объект конфигурации.
 */
export function captureResolvedConfig(binary?: string): string {
  const bin = binary ?? V1_BINARY;
  const isV2 = bin === V2_BINARY;
  log(
    'debug',
    `получение разрешённой конфигурации через ${bin} debug config${isV2 ? '' : ' --pure'}`
  );
  const captureDir = mkdtempSync(join(tmpdir(), 'host-smoke-resolved-config-'));
  const outputPath = join(captureDir, 'opencode.json');
  const output = openSync(outputPath, 'w');
  const args = isV2 ? ['debug', 'config'] : ['debug', 'config', '--pure'];
  const result = spawnSync(bin, args, {
    encoding: 'utf-8',
    stdio: ['ignore', output, 'pipe'],
  });
  try {
    closeSync(output);
  } catch {
    // Очистка дескриптора выполняется по возможности; результат команды остаётся основным.
  }
  const resolvedConfig = readFileSync(outputPath, 'utf-8');
  rmSync(captureDir, { recursive: true, force: true });
  if (result.status !== 0 || !resolvedConfig) {
    log(
      'error',
      `не удалось получить разрешённую конфигурацию; статус ${result.status ?? 'signal'}`
    );
    throw new Error(
      `${bin} debug config завершился с ошибкой (код ${result.status ?? 'signal'}): ` +
        (result.stderr || '(нет stderr)')
    );
  }
  JSON.parse(resolvedConfig);
  log('debug', `разрешённая конфигурация получена (${resolvedConfig.length} байт)`);
  return resolvedConfig;
}

/**
 * Записать конфигурационные файлы smoke-host в `opencodeDir`:
 *
 * - `opencode.json` — полная итоговая конфигурация из `captureResolvedConfig()`.
 * - `opencode.jsonc` — переопределения только для smoke (model, permissions, plugin и т.д.).
 *
 * Отделён от `startHost`, чтобы тесты могли проверить структуру файлов без
 * запуска реального процесса opencode.
 */
const V2_REVIEWER_PERMISSIONS = [
  { action: 'shell', resource: '*', effect: 'ask' },
  { action: 'shell', resource: 'git status *', effect: 'allow' },
  { action: 'shell', resource: 'git diff *', effect: 'allow' },
  { action: 'shell', resource: 'git log *', effect: 'allow' },
  { action: 'shell', resource: 'git show *', effect: 'allow' },
  { action: 'shell', resource: 'git rev-parse *', effect: 'allow' },
  { action: 'read', resource: '*', effect: 'deny' },
  { action: 'edit', resource: '*', effect: 'deny' },
] as const;

export async function writeSmokeConfigs(
  opencodeDir: string,
  operator: Awaited<ReturnType<typeof operatorProviders>>,
  model: string,
  pluginSpec: string,
  version: HostVersion = 'v1',
  operatorAuthFile?: string
): Promise<void> {
  log('debug', `запись конфигурационных файлов smoke в ${opencodeDir}`);
  await mkdir(opencodeDir, { recursive: true });

  // Полная итоговая конфигурация становится базовым файлом.
  await writeFile(
    join(opencodeDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model,
        ...(operator.provider ? { provider: operator.provider } : {}),
        ...(operator.providers
          ? {
              providers:
                version === 'v2'
                  ? withProviderApiKey(operator.providers, model, operatorAuthFile)
                  : operator.providers,
            }
          : {}),
        ...(operator.disabled_providers ? { disabled_providers: operator.disabled_providers } : {}),
        permission: { '*': 'allow', question: 'allow' },
        ...(version === 'v2'
          ? {
              agents: {
                reviewer: { permissions: V2_REVIEWER_PERMISSIONS },
                smoke_reviewer: { permissions: V2_REVIEWER_PERMISSIONS },
              },
            }
          : {}),
        ...(version === 'v2'
          ? { plugins: [{ package: pluginSpec }] }
          : { plugin: [`file://${pluginSpec}`] }),
        autoupdate: false,
        share: 'disabled',
      },
      null,
      2
    ),
    'utf-8'
  );

  log('debug', 'конфигурационный файл smoke записан');
}

export async function startHost(options: HostOptions): Promise<Host> {
  const version = options.version ?? 'v1';
  const binary = ensureOpencodeBinary(version);
  log('info', `запуск изолированного хоста (${version}) для профиля ${options.profile}`);
  const root = await mkdtemp(join(tmpdir(), 'host-smoke-'));
  const homeDir = join(root, 'home');
  const workDir = join(root, 'work');
  // Каталог конфигурации постоянный: рядом с конфигом хост ставит зависимости для загрузки
  // плагинов, и при одноразовом каталоге они скачивались заново на каждом старте. Сам файл
  // конфига прогон перезаписывает, поэтому чужого состояния здесь не остаётся.
  const configDir = smokeConfigDir();
  const dataDir = join(homeDir, 'data');
  let stop: (() => Promise<void>) | undefined;
  try {
    for (const dir of [workDir, join(configDir, 'opencode'), join(dataDir, 'opencode')]) {
      await mkdir(dir, { recursive: true });
    }
    log('debug', `созданы каталоги изолированного хоста в ${root}`);

    // Учётные данные живут в data dir; скопируем их, чтобы модель была живой.
    const auth = join(homedir(), '.local/share/opencode/auth.json');
    if (existsSync(auth)) {
      await cp(auth, join(dataDir, 'opencode', 'auth.json'));
      log('debug', 'база учётных данных оператора скопирована в изолированный каталог данных');
    } else {
      log(
        'warn',
        'база учётных данных оператора не найдена; вызовы модели могут завершиться ошибкой'
      );
    }

    const pluginSpec = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
    log('debug', `используется спецификация плагина: ${pluginSpec}`);

    // Получить полную итоговую конфигурацию оператора, чтобы дочерний хост унаследовал
    // определения провайдеров, реестр моделей и все остальные необходимые записи.
    const operator = await operatorProviders(options.model);
    await writeSmokeConfigs(
      join(configDir, 'opencode'),
      operator,
      options.model,
      pluginSpec,
      version
    );

    // Профиль, с которым плагин управляет этим проектом. `base` всегда идёт
    // вместе: каждый поставляемый профиль — это дельта поверх него.
    const profileTarget = join(workDir, '.opencode', 'profiles');
    await mkdir(profileTarget, { recursive: true });
    const profileSource = existsSync(join(REPO_ROOT, 'profiles', options.profile))
      ? join(REPO_ROOT, 'profiles', options.profile)
      : join(import.meta.dir!, '..', 'profile', options.profile);
    await cp(profileSource, join(profileTarget, options.profile), { recursive: true });
    await cp(join(REPO_ROOT, 'profiles', 'base'), join(profileTarget, 'base'), { recursive: true });

    // Хост читает список агентов один раз, при запуске, поэтому агенты профиля
    // помещаются туда, куда opencode смотрит до запуска сервера. Они регистрируются
    // под своими именами без префикса (`orchestrator`), что является одной из двух форм,
    // которые принимает плагин.
    const agentSource = join(profileSource, 'agents');
    if (existsSync(agentSource)) {
      await cp(agentSource, join(workDir, '.opencode', 'agent'), { recursive: true });
      log('debug', `агенты профиля скопированы из ${agentSource}`);
    }

    for (const [path, contents] of Object.entries(options.files ?? {})) {
      const target = join(workDir, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, contents, 'utf-8');
      log('debug', `записан файл проекта smoke ${path}`);
    }

    if (options.git !== false) {
      log('debug', 'инициализация репозитория git проекта smoke');
      run('git', ['init', '-q'], workDir);
      run('git', ['config', 'user.email', 'smoke@example.com'], workDir);
      run('git', ['config', 'user.name', 'host smoke'], workDir);
      await writeFile(join(workDir, 'README.md'), '# host smoke\n', 'utf-8');
      run('git', ['add', '-A'], workDir);
      run('git', ['commit', '-q', '-m', 'seed'], workDir);
    }

    await mkdir(smokeCacheDir(), { recursive: true });
    await mkdir(smokeNpmCacheDir(), { recursive: true });
    await mkdir(smokeConfigDir(), { recursive: true });

    const env = {
      ...isolatedEnvironment(process.env),
      ...(options.env ?? {}),
      HOME: homeDir,
      XDG_CONFIG_HOME: smokeConfigDir(),
      XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: join(homeDir, 'state'),
      XDG_CACHE_HOME: smokeCacheDir(),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // Хост ставит зависимости плагина своим npm-инсталлятором. Кеш npm по умолчанию лежит в
      // $HOME, а дом у прогона одноразовый, поэтому установка повторялась каждый старт и уходила
      // в сеть перед первой сессией. Кеш пакетов — это кеш: держим его вне временного дерева.
      npm_config_cache: smokeNpmCacheDir(),
      NPM_CONFIG_CACHE: smokeNpmCacheDir(),
      // The host resolves its own dependencies from the checkout it already has instead of
      // asking the registry on startup: an isolated host that blocks on registry.npmjs.org
      // delays the first session by a minute or more, and the resolution result is the same.
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
      // The model comes from the config this run writes, so the catalog fetch is not needed;
      // without this the host blocks on models.opencode.ai before serving the first session.
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      // Путь согласования проходит через tool `question` хоста, который
      // сервер регистрирует только для интерактивных клиентов, если не установлена эта опция.
      OPENCODE_ENABLE_QUESTION_TOOL: '1',
    };

    let buffer = '';
    // Уровень лога хоста поднимается явно (HOST_SMOKE_HOST_LOG_LEVEL) для диагностики:
    // на info причина ожидания на старте не видна.
    const hostLogLevel = (process.env.HOST_SMOKE_HOST_LOG_LEVEL ?? 'info').toLowerCase();
    const port = await freePort();
    const serveArgs =
      version === 'v2'
        ? [
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
            '--print-logs',
            '--log-level',
            hostLogLevel,
          ]
        : [
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
            '--print-logs',
            '--log-level',
            hostLogLevel.toUpperCase(),
          ];
    log('debug', `запуск процесса ${binary} ${serveArgs.join(' ')}`);
    const child: ChildProcess = spawn(binary, serveArgs, {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Лог хоста собирается в buffer и при debug дублируется наружу: без этого причина
    // ожидания на старте (что именно хост делает вместо ответа) не видна в отчёте.
    const collect = (chunk: Buffer): void => {
      buffer += chunk;
      for (const line of chunk.toString('utf8').split('\n')) {
        const text = line.trim();
        if (text.length > 0) log('debug', `[host ${version}] ${text}`);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('exit', (code, signal) => {
      log(
        code === 0 && signal === null ? 'debug' : 'error',
        `процесс opencode serve завершился: code=${code ?? 'null'} signal=${signal ?? 'null'}`
      );
    });
    // A process that cannot even be spawned emits `error` and never exits; without this the
    // run would wait for the listen timeout and blame the wrong thing.
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
    });
    log('info', 'процесс opencode serve создан; ожидание URL прослушивания');

    let stopPromise: Promise<void> | undefined;
    const hostStop = async (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        log('info', 'остановка изолированного хоста opencode');
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (child.exitCode === null) child.kill('SIGKILL');
        }
        log('info', 'процесс opencode serve остановлен');
        await rm(root, { recursive: true, force: true });
        activeHostStops.delete(hostStop);
        log('info', 'изолированный хост остановлен, временный каталог удалён');
      })();
      return stopPromise;
    };
    stop = hostStop;
    activeHostStops.add(hostStop);

    let url: string;
    try {
      url = await new Promise<string>((resolveUrl, rejectUrl) => {
        const deadline = setTimeout(() => {
          log('error', 'opencode serve не сообщил URL за 60 секунд');
          rejectUrl(new EnvironmentUnavailableError(`opencode serve не сообщил URL:\n${buffer}`));
        }, 60_000);
        const poll = setInterval(() => {
          if (spawnError !== undefined) {
            clearInterval(poll);
            clearTimeout(deadline);
            log('error', `opencode serve не запустился: ${spawnError.message}`);
            rejectUrl(
              new EnvironmentUnavailableError(`opencode serve не запустился: ${spawnError.message}`)
            );
            return;
          }
          const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
          if (!match) {
            if (child.exitCode !== null) {
              clearInterval(poll);
              clearTimeout(deadline);
              log('error', `opencode serve завершился до сообщения URL (${child.exitCode})`);
              rejectUrl(
                new EnvironmentUnavailableError(
                  `opencode serve завершился (${child.exitCode}):\n${buffer}`
                )
              );
            }
            return;
          }
          clearInterval(poll);
          clearTimeout(deadline);
          resolveUrl(match[1]!);
          log('info', `opencode serve прослушивает адрес ${match[1]}`);
        }, 100);
      });
    } catch (error) {
      await hostStop();
      throw error;
    }

    // V2 игнорирует унаследованный OPENCODE_SERVER_PASSWORD и генерирует свои
    // учётные данные, объявляемые в логе как `server password <value>`. Каждый
    // вызов `/api` требует их: без заголовка сервер отвечает 401 с пустым телом,
    // что сгенерированный клиент сообщает как
    // `UnsupportedContentType` — ошибка авторизации в костюме content-type.
    let authHeader: string | undefined;
    if (version === 'v2') {
      const password = await waitForServerPassword(() => buffer, 5_000);
      if (password) {
        authHeader = basicAuthHeader(password);
      } else {
        log('warn', 'хост v2 не сообщил пароль сервера; вызовы /api будут без аутентификации');
      }
    }

    return {
      url,
      workDir,
      homeDir,
      ...(authHeader ? { authHeader } : {}),
      logs: () => buffer,
      stop: hostStop,
    };
  } catch (error) {
    if (stop) await stop();
    else {
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function api<T>(host: Host, method: string, path: string, body?: unknown): Promise<T> {
  const requestId = ++requestSequence;
  const requestKey = `${method} ${path}`;
  const requestCount = (requestCounts.get(requestKey) ?? 0) + 1;
  const previousRequestAt = requestStartedAt.get(requestKey);
  const startedAt = performance.now();
  requestCounts.set(requestKey, requestCount);
  requestStartedAt.set(requestKey, startedAt);
  const bodySize = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body), 'utf-8');
  const sincePrevious =
    previousRequestAt === undefined
      ? ''
      : ` sincePrevious=${(startedAt - previousRequestAt).toFixed(1)}ms`;
  const requestMeta = `req=${requestId} call=${requestCount}${sincePrevious}`;
  log('debug', `${method} ${path} ${requestMeta}${bodySize > 0 ? ` body=${bodySize}b` : ''}`);
  if (isTraceEnabled() && body !== undefined) {
    const sanitized = sanitizeTracePayload(JSON.stringify(body));
    log('trace', `${method} ${path} request body: ${truncatePayload(sanitized, 2000)}`);
  }
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const responseSize = Buffer.byteLength(text, 'utf-8');
  const sanitizedResponse = sanitizeTracePayload(text);
  const debugResponse = truncatePayload(sanitizedResponse, 2000);
  if (!response.ok) {
    log(
      'error',
      `${method} ${path} ${requestMeta} returned HTTP ${response.status} (duration=${(performance.now() - startedAt).toFixed(1)}ms, resp=${responseSize}b) body=${debugResponse}`
    );
    if (isTraceEnabled()) {
      log(
        'trace',
        `${method} ${path} ${requestMeta} response body: ${truncatePayload(sanitizedResponse, 4000)}`
      );
    }
    throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  }
  log(
    'debug',
    `${method} ${path} ${requestMeta} returned HTTP ${response.status} (duration=${(performance.now() - startedAt).toFixed(1)}ms, resp=${responseSize}b) body=${debugResponse}`
  );
  if (isTraceEnabled()) {
    log(
      'trace',
      `${method} ${path} ${requestMeta} response body: ${truncatePayload(sanitizedResponse, 4000)}`
    );
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Включает ли текущий уровень логирования `trace` (т.е. равен `trace`). */
export function isTraceEnabled(): boolean {
  return configuredLogLevel() === 'trace';
}

/**
 * Сессия workflow, сохранённая плагином, или null, если плагин не записал ни одной.
 *
 * Завершённый workflow перемещается из `runtime/` в `runtime/archive/`: после
 * этого плагин ничем не управляет, и «нет сессии» выражается
 * единственным способом, принятым в этом проекте — `load` не находит файл. Сама запись
 * сохраняется, и сценарий, проверяющий, КАК завершился прогон, должен читать её
 * там, где она теперь находится.
 */
/**
 * Записать файл сессии плагина напрямую.
 *
 * Сценарию, который проверяет один механизм (например, доезжает ли вердикт субагента до гейта),
 * незачем проходить все предыдущие стадии схемы: сессию можно посадить сразу на нужную стадию.
 * Плагин читает файл как обычную сессию, поэтому запись должна быть валидной по его схеме —
 * обязательны `sessionId`, `profileId`, `schemaId`, `currentStage` и `status`, остальное
 * заполняется умолчаниями.
 */
export async function writeWorkflowSession(
  host: { homeDir: string },
  sessionId: string,
  state: unknown
): Promise<void> {
  const runtime = join(host.homeDir, 'data', 'opencode', 'session-guard', 'runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, `${sessionId}.json`), JSON.stringify(state, null, 2), 'utf-8');
  log('debug', `сессия workflow записана напрямую: ${join(runtime, `${sessionId}.json`)}`);
}

export async function readWorkflowSession(host: Host, sessionId: string): Promise<unknown | null> {
  // Плагин размещает свой runtime в data dir opencode (см. src/app/paths.ts),
  // который harness направил в изолированную домашнюю директорию.
  const runtime = join(host.homeDir, 'data', 'opencode', 'session-guard', 'runtime');
  for (const file of [
    join(runtime, `${sessionId}.json`),
    join(runtime, 'archive', `${sessionId}.json`),
  ]) {
    if (existsSync(file)) {
      log('debug', `reading workflow session from ${file}`);
      try {
        return JSON.parse(await readFile(file, 'utf-8'));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`[ERROR] не удалось прочитать файл сессии workflow ${file}: ${reason}`);
      }
    }
  }
  log('debug', `сессия workflow не найдена: ${sessionId}`);
  return null;
}
