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
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir!, '../..');

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
  /** Extra files to write into the project, path → contents. */
  files?: Record<string, string>;
  /** Whether to `git init` the project and make a seed commit. */
  git?: boolean;
  /** Extra environment for the host process. */
  env?: Record<string, string>;
}

function run(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
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
  run('bun', ['run', 'build'], REPO_ROOT);
  return join(REPO_ROOT, 'dist');
}

/** Build and pack the plugin into a tarball. Kept for packaging checks. */
export function packPlugin(): string {
  run('bun', ['run', 'build'], REPO_ROOT);
  const destination = join(tmpdir(), 'host-smoke-pack');
  const out = run('bun', ['pm', 'pack', '--destination', destination], REPO_ROOT);
  // `bun pm pack` prints a file list and a summary; the tarball path is the one
  // line that ends in .tgz on its own.
  const line = out
    .split('\n')
    .map((entry) => entry.trim())
    .findLast((entry) => entry.endsWith('.tgz') && !entry.startsWith('packed'));
  if (!line) throw new Error(`could not read the packed tarball from:\n${out}`);
  return line.startsWith('/') ? line : join(destination, line);
}

/** Strip `//` line comments so a .jsonc file parses as JSON. */
function stripComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Drop `{env:VAR}` API keys whose variable is not set in this shell.
 *
 * An unresolved template reaches the provider as an empty key and the request
 * comes back 401. Removing it lets opencode fall back to the credential it
 * already holds in `auth.json`, which the harness copied in.
 */
function resolveProviderKeys(provider: unknown): unknown {
  if (typeof provider !== 'object' || provider === null) return provider;
  for (const entry of Object.values(provider as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const options = (entry as { options?: Record<string, unknown> }).options;
    const key = options?.apiKey;
    if (typeof key !== 'string') continue;
    const template = /^\{env:([A-Z0-9_]+)\}$/.exec(key);
    if (template && !process.env[template[1]!]) delete options!.apiKey;
  }
  return provider;
}

/**
 * Provider definitions from the operator's own opencode config.
 *
 * A provider is a URL, a model list and a key — the harness needs them so the
 * run talks to a real model. Nothing else is carried over.
 */
async function operatorProviders(): Promise<{
  provider?: unknown;
  disabled_providers?: unknown;
  model?: string;
}> {
  const configHome =
    process.env.HOST_SMOKE_OPERATOR_CONFIG ?? join(homedir(), '.config', 'opencode');
  const merged: { provider?: unknown; disabled_providers?: unknown; model?: string } = {};
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = join(configHome, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(stripComments(await readFile(file, 'utf-8'))) as Record<
        string,
        unknown
      >;
      if (parsed.provider) merged.provider = resolveProviderKeys(parsed.provider);
      if (parsed.disabled_providers) merged.disabled_providers = parsed.disabled_providers;
      if (typeof parsed.model === 'string') merged.model = parsed.model;
    } catch {
      // A config we cannot read is not a reason to fail: the run will simply
      // report the model as unavailable.
    }
  }
  return merged;
}

/** The model the operator runs by default, for use when none is given. */
export async function defaultModel(): Promise<string> {
  const fromEnv = process.env.HOST_SMOKE_MODEL;
  if (fromEnv) return fromEnv;
  const model = (await operatorProviders()).model;
  if (!model) {
    throw new Error(
      'No model to run against: set HOST_SMOKE_MODEL, or declare `model` in your opencode config.'
    );
  }
  return model;
}

export async function startHost(options: HostOptions): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), 'host-smoke-'));
  const homeDir = join(root, 'home');
  const workDir = join(root, 'work');
  const configDir = join(homeDir, 'config');
  const dataDir = join(homeDir, 'data');
  for (const dir of [workDir, join(configDir, 'opencode'), join(dataDir, 'opencode')]) {
    await mkdir(dir, { recursive: true });
  }

  // Credentials live in the data dir; copy them so the model is live.
  const auth = join(homedir(), '.local/share/opencode/auth.json');
  if (existsSync(auth)) await cp(auth, join(dataDir, 'opencode', 'auth.json'));

  const pluginSpec = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
  const operator = await operatorProviders();
  await writeFile(
    join(configDir, 'opencode', 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: options.model,
        // Only the provider definitions are borrowed from the operator's own
        // config — the model has to be live. Their agents, plugins, MCP servers
        // and commands are deliberately left out of this run.
        ...(operator.provider ? { provider: operator.provider } : {}),
        ...(operator.disabled_providers ? { disabled_providers: operator.disabled_providers } : {}),
        // Consent runs through the host's `question` tool, which is denied by
        // default outside an interactive client.
        // The equivalent of `opencode run --auto` for a served session: nobody
        // is at the keyboard, so a permission the host stops to ask about would
        // hang the run instead of failing it. `serve` has no such flag, so the
        // approval is declared in config. `question` is listed on its own
        // because consent runs through it and it is denied by default outside
        // an interactive client.
        permission: { '*': 'allow', question: 'allow' },
        plugin: [`file://${pluginSpec}`],
        autoupdate: false,
        share: 'disabled',
      },
      null,
      2
    ),
    'utf-8'
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
  }

  for (const [path, contents] of Object.entries(options.files ?? {})) {
    const target = join(workDir, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents, 'utf-8');
  }

  if (options.git !== false) {
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

  let buffer = '';
  const child: ChildProcess = spawn(
    'opencode',
    ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', '--log-level', 'INFO'],
    { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (chunk) => (buffer += chunk));
  child.stderr?.on('data', (chunk) => (buffer += chunk));

  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const deadline = setTimeout(
      () => rejectUrl(new Error(`opencode serve did not report a URL:\n${buffer}`)),
      60_000
    );
    const poll = setInterval(() => {
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
      if (!match) {
        if (child.exitCode !== null) {
          clearInterval(poll);
          clearTimeout(deadline);
          rejectUrl(new Error(`opencode serve exited (${child.exitCode}):\n${buffer}`));
        }
        return;
      }
      clearInterval(poll);
      clearTimeout(deadline);
      resolveUrl(match[1]!);
    }, 100);
  });

  return {
    url,
    workDir,
    homeDir,
    logs: () => buffer,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function api<T>(host: Host, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** The workflow session the plugin persisted, or null when it wrote none. */
export async function readWorkflowSession(host: Host, sessionId: string): Promise<unknown | null> {
  // The plugin puts its runtime under the opencode data dir (see src/app/paths.ts),
  // which the harness has pointed at the isolated home.
  const file = join(
    host.homeDir,
    'data',
    'opencode',
    'session-guard',
    'runtime',
    `${sessionId}.json`
  );
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf-8'));
}
