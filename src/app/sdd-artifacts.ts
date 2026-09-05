import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function computeSha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function canonicalizePlan(content: string): string {
  return content
    .replace(/^\uFEFF/gu, '') // 1. remove BOM
    .replace(/\r\n/gu, '\n') // 2. CRLF → LF
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, '')) // 3. trim trailing spaces/tabs per line
    .join('\n')
    .replace(/\n+$/u, ''); // 4. remove trailing newlines
}

export function validateStoryId(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug);
}

/** Writes a file to the given full path. Creates parent directories if needed. */
export function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

/** Reads a file by its absolute path. Returns `null` when the file does not exist. */
export function readFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Extracts the storyId slug from a document path.
 *  Uses the last segment of the parent directory as the segment,
 *  validated against `validateStoryId`. Returns `null` when
 *  the path has no parent directory (flat name) or when the
 *  segment is invalid. */
export function dirnameSegment(filePath: string): string | null {
  const parentDir = dirname(filePath);
  // Must be a true parent directory — not '.', '.opencode', or a flat name
  if (parentDir === '.' || parentDir === filePath || !/[\\/]/u.test(parentDir)) return null;
  const basename_ = parentDir.split(/[\\/]/u).filter(Boolean).pop() ?? null;
  if (!basename_ || !validateStoryId(basename_)) return null;
  return basename_;
}
