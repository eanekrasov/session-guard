import { describe, expect, test, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureBaseline, computeChangeScope } from '../../src/app/change-scope.ts';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'workflow-scope-'));
  git(path, ['init']);
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'Test']);
  return path;
}

describe('change scope', () => {
  test('excludes unchanged pre-existing dirty files', async () => {
    directory = await repo();
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src/Dirty.kt'), 'val dirty = 1\n');
    await writeFile(join(directory, 'src/Changed.kt'), 'val changed = 1\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'baseline']);
    await writeFile(join(directory, 'src/Dirty.kt'), 'val dirty = 2\n');
    const baseline = await captureBaseline(directory);
    await writeFile(join(directory, 'src/Changed.kt'), 'val changed = 2\n');
    expect(await computeChangeScope(directory, baseline)).toEqual(['src/Changed.kt']);
  });

  test('includes untracked and deleted files', async () => {
    directory = await repo();
    await writeFile(join(directory, 'Deleted.kt'), 'val old = 1\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'baseline']);
    const baseline = await captureBaseline(directory);
    await rm(join(directory, 'Deleted.kt'));
    await writeFile(join(directory, 'New.kt'), 'val new = 1\n');
    expect(await computeChangeScope(directory, baseline)).toEqual(['Deleted.kt', 'New.kt']);
  });

  test('reports the destination path for a rename', async () => {
    directory = await repo();
    await writeFile(join(directory, 'Old.kt'), 'val old = 1\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'old']);
    const baseline = await captureBaseline(directory);
    git(directory, ['mv', 'Old.kt', 'New.kt']);
    expect(await computeChangeScope(directory, baseline)).toEqual(['New.kt']);
  });
});
