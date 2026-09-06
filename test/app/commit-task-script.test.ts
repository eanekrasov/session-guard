import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/commit-task.ts');

let repo: string;

function run(...args: string[]) {
  return spawnSync('bun', ['run', SCRIPT, ...args], { cwd: repo, encoding: 'utf-8' });
}

function head(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'commit-task-'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'test'],
  ]) {
    execFileSync('git', args, { cwd: repo });
  }
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('scripts/commit-task.ts', () => {
  it('refuses without a commit message', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit message is required');
  });

  it('refuses when nothing is staged, leaving HEAD untouched', () => {
    // The plugin reads HEAD to decide whether the step succeeded, so an empty
    // commit here would forge that proof.
    const result = run('-m', 'empty');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing staged');
  });

  it('commits every change and moves HEAD', () => {
    writeFileSync(join(repo, 'a.txt'), 'hi\n');
    const result = run('-m', 'feat: a');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('committed');
    expect(head()).toHaveLength(40);
  });

  it('commits only the paths it was given', () => {
    writeFileSync(join(repo, 'a.txt'), 'first\n');
    expect(run('-m', 'feat: a').status).toBe(0);

    writeFileSync(join(repo, 'b.txt'), 'second\n');
    writeFileSync(join(repo, 'c.txt'), 'third\n');
    expect(run('-m', 'feat: b only', 'b.txt').status).toBe(0);

    const committed = execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--name-only', '-r', head()],
      { cwd: repo, encoding: 'utf-8' }
    )
      .split('\n')
      .filter(Boolean);
    expect(committed).toEqual(['b.txt']);
  });

  it('is recognised by the plugin as a commit task', async () => {
    const { isCommitTaskCommand, hasForbiddenGitSubcommand } = await import(
      '../../src/domain/session-queries.ts'
    );
    const command = 'bun run scripts/commit-task.ts -m "feat: x"';
    expect(isCommitTaskCommand(command)).toBe(true);
    // It must not trip the direct-git block, or it could never run.
    expect(hasForbiddenGitSubcommand(command)).toBe(false);
  });
});
