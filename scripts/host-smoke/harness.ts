/**
 * Host harness — runs the real opencode against a throwaway project.
 *
 * Everything the plugin governs is driven through the host: a real
 * `opencode serve`, a real session, a real model, the real tool pipeline.
 * Nothing here reaches into the plugin's internals; assertions read the
 * session state the plugin persisted, exactly as an operator would.
 *
 * Isolation: XDG config/data/state/cache point at a temp tree, so the
 * operator's own agents, plugins and sessions never take part. The provider
 * credentials in `auth.json` are copied in — they are what makes the model
 * live.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsmin } from 'jsmin';

export const REPO_ROOT = resolve(import.meta.dir!, '../..');

/**
 * Canonical opencode binary paths.  V1 is the default; V2 is available for
 * explicit selection.  Never fall back to /opt/homebrew/bin/opencode.
 *
 * These paths must be present at run time or the harness fails early.
 */
export const V1_BINARY = '/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode';
export const V2_BINARY = '/opt/homebrew/Cellar/opencode-v2/2.0.16/bin/opencode';

export type HostVersion = 'v1' | 'v2';

/** Parse the explicit host selection without silently changing host contracts. */
export function hostVersionFromEnv(value = process.env.HOST_SMOKE_OPENCODE_VERSION): HostVersion {
  if (value === undefined || value === '') return 'v1';
  if (value === 'v1' || value === 'v2') return value;
  throw new Error(`Invalid HOST_SMOKE_OPENCODE_VERSION=${value}; expected "v1" or "v2".`);
}

/** Resolve the binary path for the requested version. */
export function opencodeBinary(version: HostVersion): string {
  if (version === 'v2') return V2_BINARY;
  return V1_BINARY;
}

export interface Host {
  /** Base URL of the running opencode server. */
  url: string;
  /** The throwaway project directory opencode was started in. */
  workDir: string;
  /** Everything the host wrote — config, data, sessions. */
  homeDir: string;
  stop: () => Promise<void>;
  /** Server stdout+stderr, for diagnosing a scenario that never ran. */
  logs: () => string;
}

export interface HostOptions {
  /** Model id, e.g. `crpt/qwen-coder-x`. Defaults to $HOST_SMOKE_MODEL. */
  model: string;
  /** Profile directory (under `profiles/`) to ship into the project. */
  profile: string;
  /** OpenCode host version to run. Defaults to 'v1'. */
  version?: HostVersion;
  /** Extra files to write into the project, path → contents. */
  files?: Record<string, string>;
  /** Whether to `git init` the project and make a seed commit. */
  git?: boolean;
  /** Extra environment for the host process. */
  env?: Record<string, string>;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const LOG_COLORS: Record<LogLevel, string> = {
  trace: '\u001b[36m',
  debug: '\u001b[90m',
  info: '\u001b[37m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

export function configuredLogLevel(): LogLevel {
  const configured = process.env.HOST_SMOKE_LOG_LEVEL?.toLowerCase();
  if (
    configured === 'trace' ||
    configured === 'debug' ||
    configured === 'info' ||
    configured === 'warn' ||
    configured === 'error'
  ) {
    return configured;
  }
  // HOST_SMOKE_DEBUG=1 remains a shorthand for debug when no explicit level is set.
  if (process.env.HOST_SMOKE_DEBUG === '1') return 'debug';
  // Also treat '1' as a shorthand for debug.
  if (configured === '1') return 'debug';
  return 'info';
}

export function log(level: LogLevel, message: string): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[configuredLogLevel()]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const colorEnabled =
    process.env.NO_COLOR === undefined &&
    (Boolean(process.env.FORCE_COLOR) || process.stderr.isTTY);
  process.stderr.write(colorEnabled ? `${LOG_COLORS[level]}${line}\u001b[0m\n` : `${line}\n`);
}

/** Max bytes for a single trace payload field before truncation. */
const TRACE_PAYLOAD_MAX = 4096;

/**
 * Redact common secret patterns (api keys, tokens, passwords) from a string.
 * Replaces the secret value with `<REDACTED>` while leaving the surrounding
 * structure intact so the shape is still readable.
 */
export function redactSecrets(text: string): string {
  return text.replace(
    /(api[_-]?key|token|password|secret|auth|credential)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-.]{16,}/gi,
    '$1=<REDACTED>'
  );
}

/**
 * Truncate a string to `max` bytes, appending a truncation marker when cut.
 * Prefers cutting at a word boundary when possible.
 */
export function truncatePayload(text: string, max = TRACE_PAYLOAD_MAX): string {
  if (Buffer.byteLength(text, 'utf-8') <= max) return text;
  let truncated = text.slice(0, max);
  // Try to cut at a word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > max * 0.75) truncated = truncated.slice(0, lastSpace);
  return `${truncated} …[truncated ${Buffer.byteLength(text, 'utf-8') - Buffer.byteLength(truncated, 'utf-8')} bytes]`;
}

/**
 * Safely truncate and redact a trace payload field.
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

/** Stop hosts that are running or still waiting for their listen URL. */
export async function stopAllHosts(): Promise<void> {
  log('debug', `stopping ${activeHostStops.size} active host(s)`);
  await Promise.allSettled([...activeHostStops].map((stop) => stop()));
  log('debug', 'all active hosts stopped');
}

function run(cmd: string, args: string[], cwd: string): string {
  log('debug', `running ${cmd} ${args.join(' ')} (cwd=${cwd})`);
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    log('error', `${cmd} exited with status ${result.status ?? 'signal'}`);
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  log('debug', `${cmd} completed successfully`);
  return (result.stdout ?? '').trim();
}

/**
 * Build the plugin and hand the host the built entrypoint directory.
 *
 * This is the same spec form an operator puts in their own opencode config
 * (`file://<...>/dist`), so the run loads the plugin the way a real install
 * does. A packed `.tgz` is *not* used: the host does not load one from a
 * `file://` spec, which is itself worth knowing before anyone ships that way.
 */
export function buildPlugin(): string {
  log('info', 'building plugin for host smoke');
  run('mise', ['run', 'build'], REPO_ROOT);
  const pluginPath = join(REPO_ROOT, 'dist');
  log('info', `plugin build ready: ${pluginPath}`);
  return pluginPath;
}

/** Build and pack the plugin into a tarball. Kept for packaging checks. */
export function packPlugin(): string {
  run('mise', ['run', 'build'], REPO_ROOT);
  const destination = mkdtempSync(join(tmpdir(), 'host-smoke-pack-'));
  try {
    const out = run('bun', ['pm', 'pack', '--destination', destination], REPO_ROOT);
    // `bun pm pack` prints a file list and a summary; the tarball path is the one
    // line that ends in .tgz on its own.
    const line = out
      .split('\n')
      .map((entry) => entry.trim())
      .findLast((entry) => entry.endsWith('.tgz') && !entry.startsWith('packed'));
    if (!line) throw new Error(`could not read the packed tarball from:\n${out}`);
    packDirectories.add(destination);
    return line.startsWith('/') ? line : join(destination, line);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Remove trailing commas after jsmin has removed JSONC comments. */
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

/** Parse JSONC using the same jsmin behavior as the V1 provider loader. */
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
      // Malformed or unreadable optional config is ignored, preserving V1 behavior.
    }
  }
  const model = requestedModel ?? merged.model;
  if (model) Object.assign(merged, filterOperatorProviders(merged, model));
  return merged;
}

/** The model the operator runs by default, for use when none is given. */
export async function defaultModel(_binary?: string): Promise<string> {
  const fromEnv = process.env.HOST_SMOKE_MODEL;
  if (fromEnv) {
    log('debug', `using model from HOST_SMOKE_MODEL: ${fromEnv}`);
    return fromEnv;
  }
  const operator = await operatorProviders();
  const model = operator.model;
  if (!model) {
    log('error', 'resolved opencode config does not declare a model');
    throw new Error(
      'No model to run against: set HOST_SMOKE_MODEL, or declare `model` in your opencode config.'
    );
  }
  log('info', `using model from resolved opencode config: ${model}`);
  return model;
}

/**
 * Kept for diagnostics only. V2 output is source documents, not a config object.
 */
export function captureResolvedConfig(binary?: string): string {
  const bin = binary ?? V1_BINARY;
  const isV2 = bin === V2_BINARY;
  log('debug', `capturing resolved config with ${bin} debug config${isV2 ? '' : ' --pure'}`);
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
    // The descriptor is best-effort cleanup; the command result remains authoritative.
  }
  const resolvedConfig = readFileSync(outputPath, 'utf-8');
  rmSync(captureDir, { recursive: true, force: true });
  if (result.status !== 0 || !resolvedConfig) {
    log('error', `resolved config capture failed with status ${result.status ?? 'signal'}`);
    throw new Error(
      `${bin} debug config failed (exit ${result.status ?? 'signal'}): ` +
        (result.stderr || '(no stderr)')
    );
  }
  JSON.parse(resolvedConfig);
  log('debug', `resolved config captured (${resolvedConfig.length} bytes)`);
  return resolvedConfig;
}

/**
 * Write the smoke host config files into `opencodeDir`:
 *
 * - `opencode.json` — the full resolved config from `captureResolvedConfig()`.
 * - `opencode.jsonc` — smoke-only overrides (model, permissions, plugin, etc.).
 *
 * Separated from `startHost` so tests can verify the file layout without
 * running a real opencode process.
 */
export async function writeSmokeConfigs(
  opencodeDir: string,
  operator: Awaited<ReturnType<typeof operatorProviders>>,
  model: string,
  pluginSpec: string,
  version: HostVersion = 'v1'
): Promise<void> {
  log('debug', `writing smoke config files to ${opencodeDir}`);
  await mkdir(opencodeDir, { recursive: true });

  // The full resolved config becomes the base file.
  await writeFile(
    join(opencodeDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model,
        ...(operator.provider ? { provider: operator.provider } : {}),
        ...(operator.providers ? { providers: operator.providers } : {}),
        ...(operator.disabled_providers ? { disabled_providers: operator.disabled_providers } : {}),
        permission: { '*': 'allow', question: 'allow' },
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

  log('debug', 'smoke config file written');
}

export async function startHost(options: HostOptions): Promise<Host> {
  const version = options.version ?? 'v1';
  const binary = opencodeBinary(version);
  log('info', `starting isolated host (${version}) for profile ${options.profile}`);
  const root = await mkdtemp(join(tmpdir(), 'host-smoke-'));
  const homeDir = join(root, 'home');
  const workDir = join(root, 'work');
  const configDir = join(homeDir, 'config');
  const dataDir = join(homeDir, 'data');
  let stop: (() => Promise<void>) | undefined;
  try {
    for (const dir of [workDir, join(configDir, 'opencode'), join(dataDir, 'opencode')]) {
      await mkdir(dir, { recursive: true });
    }
    log('debug', `created isolated host directories under ${root}`);

    // Credentials live in the data dir; copy them so the model is live.
    const auth = join(homedir(), '.local/share/opencode/auth.json');
    if (existsSync(auth)) {
      await cp(auth, join(dataDir, 'opencode', 'auth.json'));
      log('debug', 'copied operator auth database into isolated data directory');
    } else {
      log('warn', 'operator auth database not found; model calls may fail');
    }

    const pluginSpec = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
    log('debug', `using plugin specification: ${pluginSpec}`);

    // Fetch the operator's full resolved config so the child host inherits its
    // provider definitions, model registry and all other required entries.
    const operator = await operatorProviders(options.model);
    await writeSmokeConfigs(
      join(configDir, 'opencode'),
      operator,
      options.model,
      pluginSpec,
      version
    );

    // The profile the plugin governs this project with. `base` always comes
    // along: every shipped profile is a delta over it.
    const profileTarget = join(workDir, '.opencode', 'profiles');
    await mkdir(profileTarget, { recursive: true });
    const profileSource = existsSync(join(REPO_ROOT, 'profiles', options.profile))
      ? join(REPO_ROOT, 'profiles', options.profile)
      : join(import.meta.dir!, 'profile', options.profile);
    await cp(profileSource, join(profileTarget, options.profile), { recursive: true });
    await cp(join(REPO_ROOT, 'profiles', 'base'), join(profileTarget, 'base'), { recursive: true });

    // The host reads its agent roster once, at startup, so the profile's agents
    // are placed where opencode looks before the server comes up. They register
    // under their bare names (`orchestrator`), which is one of the two forms the
    // plugin accepts.
    const agentSource = join(profileSource, 'agents');
    if (existsSync(agentSource)) {
      await cp(agentSource, join(workDir, '.opencode', 'agent'), { recursive: true });
      log('debug', `copied profile agents from ${agentSource}`);
    }

    for (const [path, contents] of Object.entries(options.files ?? {})) {
      const target = join(workDir, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, contents, 'utf-8');
      log('debug', `wrote smoke project file ${path}`);
    }

    if (options.git !== false) {
      log('debug', 'initializing smoke project git repository');
      run('git', ['init', '-q'], workDir);
      run('git', ['config', 'user.email', 'smoke@example.com'], workDir);
      run('git', ['config', 'user.name', 'host smoke'], workDir);
      await writeFile(join(workDir, 'README.md'), '# host smoke\n', 'utf-8');
      run('git', ['add', '-A'], workDir);
      run('git', ['commit', '-q', '-m', 'seed'], workDir);
    }

    const env = {
      ...process.env,
      ...(options.env ?? {}),
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: join(homeDir, 'state'),
      XDG_CACHE_HOME: join(homeDir, 'cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // The consent path runs through the host's `question` tool, which the
      // server only registers for interactive clients unless this is set.
      OPENCODE_ENABLE_QUESTION_TOOL: '1',
    };
    // The smoke client talks to this disposable server without an auth header.
    // Do not inherit the operator's server password into the child host.
    // @typescript-eslint/no-dynamic-delete
    delete (env as Record<string, string | undefined>).OPENCODE_SERVER_PASSWORD;
    log('debug', 'removed inherited server password from child host environment');

    let buffer = '';
    const serveArgs =
      version === 'v2'
        ? ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', '--log-level', 'info']
        : [
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            '0',
            '--print-logs',
            '--log-level',
            'INFO',
          ];
    log('debug', `spawning ${binary} ${serveArgs.join(' ')}`);
    const child: ChildProcess = spawn(binary, serveArgs, {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => (buffer += chunk));
    child.stderr?.on('data', (chunk) => (buffer += chunk));
    log('info', 'opencode serve process started; waiting for listen URL');

    let stopPromise: Promise<void> | undefined;
    const hostStop = async (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        log('debug', 'stopping isolated opencode host');
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (child.exitCode === null) child.kill('SIGKILL');
        }
        await rm(root, { recursive: true, force: true });
        activeHostStops.delete(hostStop);
        log('debug', 'isolated host stopped and temporary directory removed');
      })();
      return stopPromise;
    };
    stop = hostStop;
    activeHostStops.add(hostStop);

    let url: string;
    try {
      url = await new Promise<string>((resolveUrl, rejectUrl) => {
        const deadline = setTimeout(() => {
          log('error', 'opencode serve did not report a URL within 60 seconds');
          rejectUrl(new Error(`opencode serve did not report a URL:\n${buffer}`));
        }, 60_000);
        const poll = setInterval(() => {
          const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
          if (!match) {
            if (child.exitCode !== null) {
              clearInterval(poll);
              clearTimeout(deadline);
              log('error', `opencode serve exited before reporting a URL (${child.exitCode})`);
              rejectUrl(new Error(`opencode serve exited (${child.exitCode}):\n${buffer}`));
            }
            return;
          }
          clearInterval(poll);
          clearTimeout(deadline);
          resolveUrl(match[1]!);
          log('info', `opencode serve is listening at ${match[1]}`);
        }, 100);
      });
    } catch (error) {
      await hostStop();
      throw error;
    }

    return {
      url,
      workDir,
      homeDir,
      logs: () => buffer,
      stop: hostStop,
    };
  } catch (error) {
    if (stop) await stop();
    else await rm(root, { recursive: true, force: true });
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
  const isQuestionPoll = method === 'GET' && path === '/question';
  if (!isQuestionPoll) {
    log('debug', `${method} ${path} ${requestMeta}${bodySize > 0 ? ` body=${bodySize}b` : ''}`);
  }
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
  const isEmptyQuestionResponse = isQuestionPoll && text.trim() === '[]';
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
  if (!isEmptyQuestionResponse) {
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
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Whether the current log level includes `trace` (i.e. is `trace`). */
export function isTraceEnabled(): boolean {
  return LOG_LEVELS[configuredLogLevel()] <= LOG_LEVELS['trace'];
}

/**
 * The workflow session the plugin persisted, or null when it wrote none.
 *
 * A finished workflow is moved out of `runtime/` into `runtime/archive/`: from
 * then on the plugin governs nothing, and "there is no session" is expressed
 * the one way this project expresses it — `load` finds no file. The record
 * itself survives, and a scenario asserting how a run ENDED has to read it
 * where it now lives.
 */
export async function readWorkflowSession(host: Host, sessionId: string): Promise<unknown | null> {
  // The plugin puts its runtime under the opencode data dir (see src/app/paths.ts),
  // which the harness has pointed at the isolated home.
  const runtime = join(host.homeDir, 'data', 'opencode', 'session-guard', 'runtime');
  for (const file of [
    join(runtime, `${sessionId}.json`),
    join(runtime, 'archive', `${sessionId}.json`),
  ]) {
    if (existsSync(file)) {
      log('debug', `reading workflow session from ${file}`);
      return JSON.parse(await readFile(file, 'utf-8'));
    }
  }
  log('debug', `workflow session not found: ${sessionId}`);
  return null;
}
