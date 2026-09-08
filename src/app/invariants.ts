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
 * P0-004: Load all invariants for a given profile.
 *
 * Resolves the profile's metadata via ProfileResolver, then dynamically
 * imports `invariants.ts` from the profile directory. The profile's
 * `invariants` field lists which invariant IDs to use; all live in the
 * profile's `invariants.ts` file together.
 *
 * @param profileId   — profile ID (e.g. "android", "harness")
 * @param profilesDir — path to the profiles directory
 */
/**
 * The invariants could not be loaded, which is not the same as there being
 * none. Both used to return `[]`, and a caller reading "nothing to check" as
 * "everything passed" turned a broken profile into a green gate.
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
    // Fail closed. A profile that cannot be resolved has not told us it has no
    // invariants — it has told us nothing, and an unrun check is not a passed
    // one. Returning [] here made a missing profile look like a clean file.
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
      // The profile declares invariants it cannot load. Same rule: silence
      // here would report the file as clean against checks that never ran.
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
 * P0-004: Load invariants for a profile and validate files against them.
 * Async overload — resolves invariants from profile, then validates.
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
 * Which files an invariant is ever offered.
 *
 * The list existed twice — here and as a literal inside `validateFiles` — and
 * both were narrow enough to hide real violations: identical CRLF raised
 * LF_ONLY in a `.ts` file and reported `checked: 0, errors: []` for the same
 * content in `.tsx`. A general rule about text has no business caring whether
 * the text is JSX.
 *
 * This is a guard against reading a binary as UTF-8, not a policy about which
 * files matter — that is each invariant's own `appliesTo`.
 */
export const SUPPORTED_EXTENSIONS =
  /\.(kt|kts|java|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|ya?ml|toml|css|scss|html|sql|sh|swift|py|go|rs|rb|gradle|properties|txt)$/i;
