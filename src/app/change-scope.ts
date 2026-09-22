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
  // `core.quotepath` on by default, поэтому git возвращает не-ASCII путь
  // C-quoted — `"\321\202\320\265\321\201\321\202.ts"` для `тест.ts`.
  // Взятое буквально файл не существует, его хеш null, и изменение молча
  // снаружи любого скоупа. Просьба к git не квотировать — фикс; альтернатива
  // — реимплементировать его эскейпинг.
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

/**
 * Что отличается от `HEAD` прямо сейчас — чистый change set, не история.
 *
 * `session.changedFiles` аккумулируется по одному ходу за раз, так что файл,
 * отредактированный и потом возвращённый, оставался в списке. Delivery permit
 * строится из этого списка, поэтому он ждал файл, которого коммит не мог
 * содержать, и правильный коммит отвергался. Пересечение с этим — что превращает
 * запись всего затронутого в сет того, что реально изменилось.
 */
export function changedAgainstHead(cwd: string, moduleRoot = ''): string[] {
  return dirtyPaths(cwd, moduleRoot);
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

  // Объединение того, что грязно сейчас, и того, что было грязно в базлайне. Ходьба
  // только по текущему грязному сету пропустила обратное направление: файл,
  // который оператор отредактировал, а операция вернула к HEAD, уже не грязен —
  // так что он никогда не сравнивался, и отмена чужой работы регестрировалась
  // как никаких изменений вовсе.
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
