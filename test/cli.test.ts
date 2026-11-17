import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createSession, WorkflowStore } from '../src/session/session-store.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const CLI = path.resolve(import.meta.dir, '..', 'src', 'cli.ts');

/**
 * A project laid out the way a real one is: profiles under `.opencode`, which
 * is also the directory the synced agents land in.
 */
async function createProject(
  options: { profileJson?: string; schema?: string } = {}
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'session-guard-cli-'));
  temporaryDirectories.push(root);

  const profileDir = path.join(root, '.opencode', 'profiles', 'demo');
  await mkdir(path.join(profileDir, 'agents'), { recursive: true });
  await writeFile(
    path.join(profileDir, 'profile.json'),
    options.profileJson ?? JSON.stringify({ id: 'demo' })
  );
  await writeFile(path.join(profileDir, 'agents', 'code.md'), '# Code agent\n', 'utf-8');
  if (options.schema !== undefined) {
    await writeFile(path.join(profileDir, 'demo.yaml'), options.schema, 'utf-8');
  }

  return root;
}

/**
 * Run the real entrypoint the way a user does — as a process, not a function.
 *
 * The path overrides are cleared so the command resolves its directories the
 * way it will on a user's machine: from `--cwd` alone. Without this a
 * neighbouring test's `SESSION_GUARD_PROFILES_DIR` would decide the answer.
 */
async function runCli(
  args: string[],
  storeDir?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SESSION_GUARD_PROFILES_DIR;
  delete env.OPENCODE_HARNESS_DIR;
  delete env.SESSION_GUARD_STORE_DIR;
  if (storeDir !== undefined) env.SESSION_GUARD_STORE_DIR = storeDir;

  const child = Bun.spawn(['bun', 'run', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function seedSessions(storeDir: string): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDir);
  await store.save(createSession('active-one', 'demo', 'demo', 'running'));
  await store.save(createSession('archived-one', 'demo', 'demo', 'done'));
  await store.archive('archived-one');
  return store;
}

describe('session-guard sync-agents', () => {
  it('writes every profile agent and exits 0', async () => {
    const root = await createProject();

    const result = await runCli(['--cwd', root]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(root, '.opencode', 'agents', 'demo_code.md'))).toBe(true);
    expect(result.stdout).toContain('demo: 1 synced, 0 removed, 0 collisions, 0 errors');
    expect(result.stdout).toContain('Total: 1 synced');
  });

  it('exits 1 when a profile could not be synchronized', async () => {
    const root = await createProject({ profileJson: '{ not json' });

    const result = await runCli(['--cwd', root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Failed to parse');
    expect(result.stdout).toContain('demo: 0 synced');
  });

  it('exits 2 and prints usage for an unknown argument', async () => {
    const result = await runCli(['--nope']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown argument: --nope');
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 2 when --cwd is given without a value', async () => {
    const result = await runCli(['--cwd']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--cwd needs a directory');
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: session-guard sync-agents');
  });

  it('accepts --cwd=<dir> as well as --cwd <dir>', async () => {
    const root = await createProject();

    const result = await runCli([`--cwd=${root}`]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(root, '.opencode', 'agents', 'demo_code.md'))).toBe(true);
  });
});

describe('session-guard validate-schemas', () => {
  it('validates a declared schema and exits 0', async () => {
    const root = await createProject({
      profileJson: JSON.stringify({ id: 'demo', schemas: ['demo.yaml'] }),
      schema: 'stages:\n  done: {}\n',
    });

    const result = await runCli(['validate-schemas', '--cwd', root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('demo/demo: valid');
    expect(result.stdout).toContain('all schemas valid');
  });

  it('reports an invalid schema and exits 1', async () => {
    const root = await createProject({
      profileJson: JSON.stringify({ id: 'demo', schemas: ['demo.yaml'] }),
      schema: 'stages: []\n',
    });

    const result = await runCli(['validate-schemas', '--cwd', root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('demo:');
    expect(result.stdout).toContain('error(s)');
  });
});

describe('session-guard sessions', () => {
  it('lists schemas and their root descriptions', async () => {
    const root = await createProject({
      profileJson: JSON.stringify({ id: 'demo', schemas: ['demo.yaml'] }),
      schema: 'description: Build and verify\nstages:\n  done: {}\n',
    });

    const result = await runCli(['sessions', 'schemas', '--cwd', root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('demo/demo: Build and verify');
  });

  it('lists archived session ids with their workflow context', async () => {
    const root = await createProject();
    const store = await seedSessions(path.join(root, 'sessions'));

    const result = await runCli(['sessions', 'archived'], path.join(root, 'sessions'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('archived-one | demo/demo | done');
    expect(result.stdout).not.toContain('active-one');
    expect(await store.load('active-one')).not.toBeNull();
  });

  it('lists active sessions without including archived sessions', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    await seedSessions(storeDir);

    const result = await runCli(['sessions', 'list'], storeDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('active-one | demo/demo | running');
    expect(result.stdout).not.toContain('archived-one');
  });

  it('prints active and archived sessions as JSON arrays when requested', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    await seedSessions(storeDir);

    const active = await runCli(['--json', 'sessions', 'list'], storeDir);
    const archived = await runCli(['sessions', 'archived', '--json'], storeDir);

    expect(JSON.parse(active.stdout)).toMatchObject([
      { sessionId: 'active-one', profileId: 'demo', currentStage: 'running' },
    ]);
    expect(JSON.parse(archived.stdout)).toMatchObject([
      { sessionId: 'archived-one', profileId: 'demo', currentStage: 'done' },
    ]);
  });

  it('prints resolved schema descriptions as JSON when requested', async () => {
    const root = await createProject({
      profileJson: JSON.stringify({ id: 'demo', schemas: ['demo.yaml'] }),
      schema: 'description: Build and verify\nstages:\n  done: {}\n',
    });

    const result = await runCli(['sessions', 'schemas', '--json', '--cwd', root]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject([
      {
        profileId: 'demo',
        schemas: [{ id: 'demo', description: 'Build and verify', stages: { done: {} } }],
      },
    ]);
  });

  it('shows a single active or archived session as JSON', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    await seedSessions(storeDir);

    const active = await runCli(['sessions', 'show', 'active-one'], storeDir);
    const archived = await runCli(['sessions', 'show', 'archived-one', '--archived'], storeDir);

    expect(JSON.parse(active.stdout)).toMatchObject({
      sessionId: 'active-one',
      profileId: 'demo',
      currentStage: 'running',
    });
    expect(JSON.parse(archived.stdout)).toMatchObject({
      sessionId: 'archived-one',
      profileId: 'demo',
      currentStage: 'done',
    });
  });

  it('restores an archived session without overwriting an active session', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    const missing = await runCli(['sessions', 'restore', 'missing'], storeDir);
    expect(missing.exitCode).toBe(1);

    const store = await seedSessions(storeDir);

    const result = await runCli(['sessions', 'restore', 'archived-one'], storeDir);

    expect(result.exitCode).toBe(0);
    expect(await store.load('archived-one')).not.toBeNull();
    expect(await store.loadArchived('archived-one')).toBeNull();

    await store.archive('archived-one');
    await store.save(createSession('archived-one', 'demo', 'demo', 'active'));
    const conflict = await runCli(['sessions', 'restore', 'archived-one'], storeDir);
    expect(conflict.exitCode).toBe(1);
    expect(await store.load('archived-one')).not.toBeNull();
    expect(await store.loadArchived('archived-one')).not.toBeNull();
  });

  it('deletes one active session by id', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    const store = await seedSessions(storeDir);

    const result = await runCli(['sessions', 'delete', 'active-one'], storeDir);

    expect(result.exitCode).toBe(0);
    expect(await store.load('active-one')).toBeNull();
    expect(await store.loadArchived('archived-one')).not.toBeNull();
  });

  it('deletes one archived session when --archived is specified', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    const store = await seedSessions(storeDir);

    const result = await runCli(['sessions', 'delete', 'archived-one', '--archived'], storeDir);

    expect(result.exitCode).toBe(0);
    expect(await store.loadArchived('archived-one')).toBeNull();
    expect(await store.load('active-one')).not.toBeNull();
  });

  it('clears archived sessions only with --yes', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    const store = await seedSessions(storeDir);

    const result = await runCli(['sessions', 'clear', '--archived', '--yes'], storeDir);

    expect(result.exitCode).toBe(0);
    expect(await store.loadArchived('archived-one')).toBeNull();
    expect(await store.load('active-one')).not.toBeNull();
  });

  it('requires --yes before clearing active and archived sessions', async () => {
    const root = await createProject();
    const storeDir = path.join(root, 'sessions');
    const store = await seedSessions(storeDir);

    const rejected = await runCli(['sessions', 'clear', '--all'], storeDir);
    expect(rejected.exitCode).toBe(2);
    expect(await store.load('active-one')).not.toBeNull();
    expect(await store.loadArchived('archived-one')).not.toBeNull();

    const result = await runCli(['sessions', 'clear', '--all', '--yes'], storeDir);
    expect(result.exitCode).toBe(0);
    expect(await store.load('active-one')).toBeNull();
    expect(await store.loadArchived('archived-one')).toBeNull();
  });
});
