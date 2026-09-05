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
    console.error('[ERROR] getAllProfileInvariants: profile resolution failed', {
      profileId,
      profilesDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (enabledIds.size === 0) return [];

  // Try to dynamically import the profile's invariants.ts file
  const invariantsPath = join(profilesDir, profileId, 'invariants.ts');
  let allChecks: InvariantCheck[] = [];

  try {
    const mod = await import(invariantsPath);
    allChecks = (mod.INVARIANTS as InvariantCheck[]) ?? [];
  } catch (err) {
    // Fallback: try via file:// protocol (Bun/Node compatibility)
    try {
      const filePath = join(profilesDir, profileId, 'invariants.ts');
      const mod = await import(`file://${filePath}`);
      allChecks = (mod.INVARIANTS as InvariantCheck[]) ?? [];
    } catch {
      console.error('[ERROR] getAllProfileInvariants: cannot load invariants.ts for profile', {
        profileId,
        invariantsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
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
    if (!/\.(kt|ts|json|md)$/i.test(fileName)) continue;

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
export const SUPPORTED_EXTENSIONS = /\.(kt|ts|json|md)$/i;
