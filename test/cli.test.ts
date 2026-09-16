import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

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
async function createProject(options: { profileJson?: string } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'session-guard-cli-'));
  temporaryDirectories.push(root);

  const profileDir = path.join(root, '.opencode', 'profiles', 'demo');
  await mkdir(path.join(profileDir, 'agents'), { recursive: true });
  await writeFile(
    path.join(profileDir, 'profile.json'),
    options.profileJson ?? JSON.stringify({ id: 'demo' })
  );
  await writeFile(path.join(profileDir, 'agents', 'code.md'), '# Code agent\n', 'utf-8');

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
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SESSION_GUARD_PROFILES_DIR;
  delete env.OPENCODE_HARNESS_DIR;

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
