import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = '/tmp/session-guard-plugin-test-' + Date.now();
const ORIG_STORE_DIR = process.env.SESSION_GUARD_STORE_DIR;
const ORIG_HARNESS_DIR = process.env.OPENCODE_HARNESS_DIR;
const ORIG_PROFILES_DIR = process.env.SESSION_GUARD_PROFILES_DIR;

const DEFAULT_STORE = join(homedir(), '.local/share/opencode/session-guard/runtime');

function makeMockCtx(overrides?: Record<string, unknown>) {
  return {
    client: {} as Record<string, unknown>,
    project: {
      id: 'test',
      name: 'test',
      directory: TEST_DIR,
      worktree: TEST_DIR,
      time: { created: Date.now() },
    },
    directory: TEST_DIR,
    worktree: TEST_DIR,
    serverUrl: new URL('http://localhost:0'),
    $: {} as Record<string, unknown>,
    experimental_workspace: {} as Record<string, unknown>,
    ...overrides,
  };
}

describe('plugin.ts', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.SESSION_GUARD_STORE_DIR;
    delete process.env.SESSION_GUARD_PROFILES_DIR;
    delete process.env.OPENCODE_HARNESS_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    if (ORIG_STORE_DIR) process.env.SESSION_GUARD_STORE_DIR = ORIG_STORE_DIR;
    if (ORIG_HARNESS_DIR) process.env.OPENCODE_HARNESS_DIR = ORIG_HARNESS_DIR;
    if (ORIG_PROFILES_DIR) process.env.SESSION_GUARD_PROFILES_DIR = ORIG_PROFILES_DIR;
    else delete process.env.SESSION_GUARD_PROFILES_DIR;
  });

  it('leaves the environment alone and derives the default store itself', async () => {
    // The plugin used to write its computed defaults into process.env. That
    // turned the first project's local default into a global override, and a
    // second instance for another project read the first project's value.
    const { SessionGuardPluginV1 } = await import('../../src/index.ts');
    const { sessionsDir, opencodeStateDir } = await import('../../src/app/paths.ts');

    const ctx = makeMockCtx();
    await SessionGuardPluginV1(ctx as never);

    expect(process.env.SESSION_GUARD_STORE_DIR).toBeUndefined();
    expect(process.env.SESSION_GUARD_PROFILES_DIR).toBeUndefined();
    expect(sessionsDir(opencodeStateDir())).toBe(DEFAULT_STORE);
  });

  it('does not override existing SESSION_GUARD_STORE_DIR', async () => {
    process.env.SESSION_GUARD_STORE_DIR = '/custom/store/dir';

    const { SessionGuardPluginV1 } = await import('../../src/index.ts');

    const ctx = makeMockCtx();
    await SessionGuardPluginV1(ctx as never);

    expect(process.env.SESSION_GUARD_STORE_DIR).toBe('/custom/store/dir');
  });

  it('respects OPENCODE_HARNESS_DIR for profiles', async () => {
    const { SessionGuardPluginV1 } = await import('../../src/index.ts');
    const { profilesDir } = await import('../../src/app/paths.ts');

    process.env.OPENCODE_HARNESS_DIR = 'custom-harness';

    const ctx = makeMockCtx();
    await SessionGuardPluginV1(ctx as never);

    expect(profilesDir(TEST_DIR)).toBe(join(TEST_DIR, 'custom-harness/profiles'));
    expect(process.env.SESSION_GUARD_PROFILES_DIR).toBeUndefined();
  });

  it('respects absolute OPENCODE_HARNESS_DIR', async () => {
    const { SessionGuardPluginV1 } = await import('../../src/index.ts');
    const { profilesDir } = await import('../../src/app/paths.ts');

    process.env.OPENCODE_HARNESS_DIR = '/absolute/path';

    const ctx = makeMockCtx();
    await SessionGuardPluginV1(ctx as never);

    expect(profilesDir(TEST_DIR)).toBe('/absolute/path/profiles');
  });

  it('state store remains global regardless of OPENCODE_HARNESS_DIR', async () => {
    const { SessionGuardPluginV1 } = await import('../../src/index.ts');
    const { sessionsDir, opencodeStateDir } = await import('../../src/app/paths.ts');

    process.env.OPENCODE_HARNESS_DIR = 'custom-harness';
    const ctx = makeMockCtx();
    await SessionGuardPluginV1(ctx as never);

    expect(sessionsDir(opencodeStateDir())).toBe(DEFAULT_STORE);
    expect(process.env.SESSION_GUARD_STORE_DIR).toBeUndefined();
  });

  it('validates catch block exists in source', async () => {
    const pluginSource = readFileSync(join(import.meta.dirname, '../../src/index.ts'), 'utf-8');

    expect(pluginSource).toContain('try {');
    expect(pluginSource).toContain('catch (e)');
    expect(pluginSource).toContain('sm-init-error.json');
    expect(pluginSource).toContain('writeFileSync');
    expect(pluginSource).toContain('return {}');
  });
});
