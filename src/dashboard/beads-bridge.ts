/**
 * Beads Bridge — обёртка над `bd` CLI через ShellExecutor.
 *
 * Использует `createBunExecutor` из provider.ts для всех вызовов `bd`.
 *
 * Fallback при недоступности `bd` CLI: graceful degradation — функции возвращают
 * `{ error, degraded: true }`, сервер НЕ падает.
 *
 * Кеширование: результаты `bd show` и `bd ready` кешируются 30 секунд.
 */

import { createBunExecutor, type Task } from '../app/provider.ts';

export type { Task } from '../app/provider.ts';

export type BeadsIssue = Task;

export interface BeadsReadyResult {
  issues: BeadsIssue[];
  degraded: false;
}

export interface BeadsDegradedResult {
  error: string;
  degraded: true;
}

export type BeadsReadyResponse = BeadsReadyResult | BeadsDegradedResult;
export type BeadsIssueResponse = BeadsIssue | BeadsDegradedResult;

const TTL_MS = 30_000;

export const BD_COMMENT_CMD = 'bd comment';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

export function _getCached<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.value as T;
}

export function _setCache(key: string, value: unknown): void {
  _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function _cacheKey(cmd: string, ...args: string[]): string {
  return `${cmd}:${args.join(' ')}`;
}

const _exec = createBunExecutor('bd');

export async function getIssue(id: string): Promise<BeadsIssueResponse> {
  const cacheKey = _cacheKey('show', id);
  const cached = _getCached<BeadsIssue>(cacheKey);
  if (cached) return cached;

  const result = await _exec.run(['show', id, '--json']);
  if (!result.ok) {
    return { error: 'bd not available', degraded: true };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const issue = parsed as Task;
    _setCache(cacheKey, issue);
    return issue;
  } catch {
    return { error: 'bd not available', degraded: true };
  }
}

export async function getReady(): Promise<BeadsReadyResponse> {
  const cacheKey = _cacheKey('ready');
  const cached = _getCached<BeadsIssue[]>(cacheKey);
  if (cached) return { issues: cached, degraded: false };

  const result = await _exec.run(['ready', '--json']);
  if (!result.ok) {
    return { error: 'bd not available', degraded: true };
  }

  try {
    const raw = JSON.parse(result.stdout);
    const issues: BeadsIssue[] = (Array.isArray(raw) ? raw : []).map(
      (item: unknown) => item as Task
    );
    _setCache(cacheKey, issues);
    return { issues, degraded: false };
  } catch {
    return { error: 'bd not available', degraded: true };
  }
}

function _escapeArg(value: string): string {
  return value.replace(/["$\\`]/g, (c) => `\\${c}`);
}

export async function postComment(issueId: string, text: string, author: string): Promise<void> {
  const safeText = _escapeArg(text);
  const safeAuthor = _escapeArg(author);

  const { exitCode, stderr } = await _exec.runRaw([
    'comment',
    issueId,
    safeText,
    '--actor',
    safeAuthor,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `bd comment failed with code ${exitCode}`);
  }
}
