/**
 * invariants.ts — модуль инвариантов.
 *
 * Загружает InvariantCheck функции из profile-директории и прогоняет их
 * на списке изменённых файлов. Профили экспортируют массив `INVARIANTS`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { ProfileResolver } from './profile-resolver.ts';

export interface InvariantViolation {
  invariant: string;
  severity: 'error' | 'warning';
  file: string;
  message: string;
  line: number;
}

export interface InvariantCheck {
  id: string;
  severity: 'error' | 'warning';
  check: (content: string, filePath: string, absolutePath: string) => string | null;
  appliesTo?: (filePath: string) => boolean;
}

export interface InvariantResult {
  errors: InvariantViolation[];
  warnings: InvariantViolation[];
  checked: number;
}

export interface ProfileInvariants {
  id: string;
  invariants: InvariantCheck[];
}

/**
 * Импортировать первый доступный из кандидатов; бросить, если ни один не читается.
 */
async function importFirst(paths: string[]): Promise<InvariantCheck[]> {
  let last: unknown;
  for (const path of paths) {
    try {
      const mod = await import(path);
      return (mod.INVARIANTS as InvariantCheck[]) ?? [];
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error('no invariants module to import');
}

/**
 * P0-004: Загрузить все инварианты для данного профиля.
 *
 * Резолвит метаданные профиля через ProfileResolver, затем динамически
 * импортирует `invariants.ts` из директории профиля. Поле профиля
 * `invariants` перечисляет ID инвариантов для использования; все живут в
 * `invariants.ts` профиля вместе.
 *
 * @param profileId   — ID профиля (например "android", "harness")
 * @param profilesDir — путь к директории профилей
 */
/**
 * Инварианты не удалось загрузить, что не то же самое что их отсутствия.
 * Оба раньше возвращали `[]`, и вызывающий код, читавший "nothing to check" как
 * "everything passed", превращал сломанный профиль в зелёный гейт.
 */
export class InvariantsUnavailableError extends Error {
  readonly name = 'InvariantsUnavailableError';
}

export async function getAllProfileInvariants(
  profileId: string,
  profilesDir: string
): Promise<InvariantCheck[]> {
  let enabledIds: Set<string>;
  try {
    const resolver = new ProfileResolver(profilesDir);
    const resolved = await resolver.resolve(profileId);
    enabledIds = new Set(resolved.metadata.invariants ?? []);
  } catch (err) {
    // Fail closed. Профиль, который не резолвится, не сказал нам, что у него нет
    // инвариантов — он сказал нам ничего, и незапущенная проверка не пройденная.
    // Возврат [] тут заставил отсутствующий профиль выглядеть как чистый файл.
    throw new InvariantsUnavailableError(
      `Cannot load invariants for profile "${profileId}" from ${profilesDir}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (enabledIds.size === 0) return [];

  // Файл ищется по цепочке `extends`, а не только у самого профиля: список id
  // наследуется от предка, и реализация лежит там же. Дельта-профиль вроде
  // `smoke` наследует список у `base` и своего файла не имеет — до этой правки
  // он получал бросок «declares N invariant(s) but ... cannot be loaded» на
  // каждом ходу, а с ним и провальный вердикт `run.checks`.
  const chain = await new ProfileResolver(profilesDir).profileChain(profileId);
  const candidates = chain.map((entry) => join(profilesDir, entry.id, 'invariants.ts'));
  const invariantsPath = candidates[0] ?? join(profilesDir, profileId, 'invariants.ts');
  let allChecks: InvariantCheck[] = [];

  try {
    allChecks = await importFirst(candidates);
  } catch (err) {
    try {
      allChecks = await importFirst(candidates.map((path) => `file://${path}`));
    } catch {
      // Профиль декларирует инварианты, которые не может загрузить. То же правило:
      // тишина тут репортит файл как чистый против проверок, которые никогда не
      // бегали.
      throw new InvariantsUnavailableError(
        `Profile "${profileId}" declares ${enabledIds.size} invariant(s) but ${invariantsPath} ` +
          `cannot be loaded: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Filter to only enabled invariants by ID
  return allChecks.filter((c) => enabledIds.has(c.id));
}

/**
 * P0-004: Загрузить инварианты для профиля и проверить файлы против них.
 * Async overload — резолвит инварианты из профиля, затем валидирует.
 *
 * @param filePaths   — массив путей к файлам для проверки
 * @param profileId   — profile ID (e.g. "android", "harness")
 * @param profilesDir — path to the profiles directory
 * @param rootDirectory — корень проекта (default: process.cwd())
 */
export async function validateFilesForProfile(
  filePaths: string[],
  profileId: string,
  profilesDir: string,
  rootDirectory = process.cwd()
): Promise<InvariantResult> {
  const invariants = await getAllProfileInvariants(profileId, profilesDir);
  return validateFiles(filePaths, invariants, rootDirectory);
}

/**
 * Прогоняет все переданные инварианты на списке файлов.
 *
 * @param filePaths   — массив путей к файлам для проверки
 * @param invariants  — массив InvariantCheck из профилей
 * @param rootDirectory — корень проекта (default: process.cwd())
 */
export function validateFiles(
  filePaths: string[],
  invariants: InvariantCheck[],
  rootDirectory = process.cwd()
): InvariantResult {
  const errors: InvariantViolation[] = [];
  const warnings: InvariantViolation[] = [];
  let checked = 0;

  for (const rawPath of filePaths) {
    const filePath = resolve(rawPath);
    if (!existsSync(filePath)) continue;

    const fileName = relative(rootDirectory, filePath).replace(/\\/g, '/');
    if (!SUPPORTED_EXTENSIONS.test(fileName)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      errors.push({
        invariant: 'FILE_READABLE',
        severity: 'error',
        file: fileName,
        line: 1,
        message: 'Изменённый файл невозможно прочитать.',
      });
      continue;
    }

    if (!content && fileName.endsWith('.kt')) {
      errors.push({
        invariant: 'FILE_READABLE',
        severity: 'error',
        file: fileName,
        line: 1,
        message: 'Изменённый Kotlin-файл пуст.',
      });
      continue;
    }

    checked++;

    for (const inv of invariants) {
      if (inv.appliesTo && !inv.appliesTo(fileName)) continue;
      const msg = inv.check(content, fileName, filePath);
      if (msg) {
        const violation: InvariantViolation = {
          invariant: inv.id,
          severity: inv.severity,
          file: fileName,
          message: msg,
          line: Math.max(
            1,
            content.split('\n').findIndex((line) => msg.includes(line.trim().substring(0, 80))) + 1
          ),
        };
        (inv.severity === 'error' ? errors : warnings).push(violation);
      }
    }
  }

  return { errors, warnings, checked };
}

/** Расширения файлов, на которых запускаются инварианты. */
/**
 * На каких файлах инвариант когда-либо предлагается.
 *
 * Список существовал дважды — тут и как литерал внутри `validateFiles` — и
 * оба были достаточно узкими чтобы прятать реальные нарушения: одинаковые
 * CRLF поднимали LF_ONLY в `.ts` файле и репортили `checked: 0, errors: []`
 * для того же контента в `.tsx`. Общее правило про текст не должно заботиться,
 * JSX ли текст.
 *
 * Это защита от чтения бинарника как UTF-8, не политика о том, какие файлы
 * важны — это `appliesTo` каждого инварианта сам решает.
 */
export const SUPPORTED_EXTENSIONS =
  /\.(kt|kts|java|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|ya?ml|toml|css|scss|html|sql|sh|swift|py|go|rs|rb|gradle|properties|txt)$/i;
