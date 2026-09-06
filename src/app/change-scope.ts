import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export type BaselineHashes = Record<string, string | null>;

function git(cwd: string, args: string[], trim = true): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} завершился ошибкой: ${result.stderr}`);
  const output = result.stdout || '';
  return trim ? output.trim() : output;
}

function dirtyPaths(cwd: string, moduleRoot?: string): string[] {
  // `core.quotepath` is on by default, so git returns a non-ASCII path
  // C-quoted — `"\321\202\320\265\321\201\321\202.ts"` for `тест.ts`.
  // Taken literally the file does not exist, its hash is null, and the change
  // is silently outside every scope. Asking git not to quote is the fix; the
  // alternative is re-implementing its escaping.
  const output = git(
    cwd,
    ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'],
    false
  );
  if (!output) return [];
  const renameArrow = / -> /u;
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (!line || line.length < 3) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    if ((status.includes('R') || status.includes('C')) && renameArrow.test(path)) {
      path = path.split(renameArrow)[1] ?? path;
    }
    if (!path) continue;
    if (moduleRoot && !path.startsWith(moduleRoot)) continue;
    paths.push(path);
  }
  return [...new Set(paths)].sort();
}

async function hash(cwd: string, path: string): Promise<string | null> {
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) return null;
  return createHash('sha256')
    .update(await readFile(absolute))
    .digest('hex');
}

export async function captureBaseline(cwd: string, moduleRoot = ''): Promise<BaselineHashes> {
  return Object.fromEntries(
    await Promise.all(
      dirtyPaths(cwd, moduleRoot).map(async (path) => [path, await hash(cwd, path)])
    )
  );
}

export async function computeChangeScope(
  cwd: string,
  baseline: BaselineHashes,
  moduleRoot = ''
): Promise<string[]> {
  const root = resolve(cwd);
  const result: string[] = [];

  // The union of what is dirty now and what was dirty at the baseline. Walking
  // only the current dirty set missed the reverse direction: a file the
  // operator had edited, which the operation put back to HEAD, is no longer
  // dirty — so it was never compared, and undoing somebody's work registered
  // as no change at all.
  const candidates = new Set<string>(dirtyPaths(cwd, moduleRoot));
  for (const path of Object.keys(baseline)) {
    if (moduleRoot && !path.startsWith(moduleRoot)) continue;
    candidates.add(path);
  }

  for (const path of candidates) {
    const normalized = relative(root, resolve(root, path));
    if (isAbsolute(normalized) || normalized.startsWith('..')) continue;
    if (!(path in baseline) || baseline[path] !== (await hash(cwd, path))) result.push(path);
  }
  return result.sort();
}
