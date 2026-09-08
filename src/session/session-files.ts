/**
 * Reading sessions off disk: the file naming rule, and the schema.
 *
 * Three readers used to know both independently — the store, the dashboard and
 * the TUI — and they had already drifted. The dashboard stripped the extension
 * with a first-match replace, so the file `a.jsonb.json` reported the session
 * `ab.json`, and it decoded outside its own `try`, so a single undecodable
 * name threw `URIError` and hid every session at once.
 *
 * What a reader gets back is a `WorkflowSession` that passed the current
 * schema. There is one schema; a file that does not satisfy it is not a
 * session this project can describe, and saying so is more use to a reader
 * than half-rendering it.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowSessionSchema } from './session-schema.ts';
import type { WorkflowSession } from './session-schema.ts';

const EXTENSION = '.json';

/** The file a session id is stored under, within a store directory. */
export function sessionFileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}${EXTENSION}`;
}

/**
 * The session id a file name stands for, or `null` when it stands for none.
 *
 * Every name this project writes is `encodeURIComponent`d, so a name that will
 * not decode was written by something else. A store directory holds whatever
 * the operator puts there: such a name is skipped, never fatal.
 */
export function sessionIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(EXTENSION)) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -EXTENSION.length));
  } catch {
    return null;
  }
}

/** Every session id the directory names. A missing directory names none. */
export async function listSessionIds(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const id = sessionIdFromFileName(entry.name);
    if (id !== null) ids.push(id);
  }
  return ids.sort();
}

/**
 * One session, or `null` when the directory holds none by that id.
 *
 * Absent, unreadable, not JSON and not a session under the current schema are
 * one answer on purpose: the caller has nothing to render either way.
 */
export async function readSession(
  directory: string,
  sessionId: string
): Promise<WorkflowSession | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(directory, sessionFileName(sessionId)), 'utf-8');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = WorkflowSessionSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Every session the directory holds, keyed by id. Unreadable ones are absent. */
export async function readAllSessions(directory: string): Promise<Record<string, WorkflowSession>> {
  const sessions: Record<string, WorkflowSession> = {};
  for (const id of await listSessionIds(directory)) {
    const session = await readSession(directory, id);
    if (session !== null) sessions[id] = session;
  }
  return sessions;
}

/**
 * Где лежат законченные сессии — подкаталог рантайма.
 *
 * Подкаталогом, а не соседом: каталог рантайма задаётся извне
 * (`STATE_MACHINE_STORE_DIR`), и сосед у произвольного пути — это уже
 * догадка о структуре вокруг него. `list()` перечисляет только файлы, так
 * что архив ему не мешает.
 */
export function archiveDirOf(runtimeDirectory: string): string {
  return path.join(runtimeDirectory, 'archive');
}
