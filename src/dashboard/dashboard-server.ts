/**
 * Dashboard Standalone Server
 * Запуск: bun run src/dashboard/dashboard-server.ts
 *
 * Работает как ОТДЕЛЬНЫЙ процесс (не внутри плагина OpenCode).
 * Читает сессии из store и раздаёт SSE + HTML + API.
 *
 * Здесь только окружение и сокет. Всё остальное — в `dashboard-app.ts`,
 * который ничего не запускает при импорте и все свои каталоги принимает
 * аргументами: это и есть то, что позволяет писать про дашборд тесты о
 * поведении, а не про его собственный текст.
 *
 * API:
 *   GET /api/schema                       — контракт дашборда (dashboard-schema-v1)
 *   GET /api/session/:id                  — одна сессия по ID, с вычисляемым stage
 *   GET /api/session/:id/timeline         — TimelineEvent[] с таймстампами
 *   GET /api/session/:id/invariants       — InvariantViolation[] из invariantViolations[]
 *   GET /api/metrics                      — чтение .opencode/metrics.jsonl
 *   GET /api/rag-eval                     — чтение .opencode/rag/eval-results.json
 *   GET /api/agents/:id/prompt            — белый список агентов + path traversal защита
 *   GET /api/dump                         — все сессии (совместимость)
 *   GET /events                           — SSE: инкрементальные события + snapshot на подключение
 */

import { serve } from 'bun';
import { join, resolve } from 'node:path';
import { createDashboard } from './dashboard-app.ts';
import { harnessDir, opencodeStateDir, profilesDir, sessionsDir } from '../app/paths.ts';

const PROJECT_ROOT = resolve(join(import.meta.dir, '..', '..'));

/** Simple logger for standalone dashboard server. */
function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, unknown>
): void {
  const prefix = level === 'error' ? '[ERROR] ' : level === 'warn' ? '[WARN] ' : '';
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : '';
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} ${prefix}${message}${extraStr}`);
}
const BIND_HOST = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';
const PORT = 3456;

const dashboard = createDashboard({
  /**
   * The store the plugin actually writes to.
   *
   * This was hardcoded to `<repo>/.opencode/session-guard/sessions`, a path
   * nothing has written since the store moved out of the project — so the
   * dashboard read an empty directory and showed no sessions while the plugin
   * was running. `sessionsDir` is the same rule the plugin and the TUI use:
   * SESSION_GUARD_STORE_DIR when set, otherwise OpenCode's own state directory.
   */
  sessionsDir: sessionsDir(opencodeStateDir()),
  /**
   * Where profiles live, by the same rule the plugin uses:
   * `SESSION_GUARD_PROFILES_DIR` when the operator sets it, otherwise the
   * project's own `.opencode/profiles`. This repository keeps its shipped
   * profiles in `profiles/` and is not itself a governed project, so running
   * the dashboard here wants the override.
   */
  profilesDir: profilesDir(PROJECT_ROOT),
  opencodeRoot: resolve(join(PROJECT_ROOT, '.opencode')),
  /**
   * Where the plugin's profile agent sync puts prompts:
   * `<harness>/agents/<profileId>_<agent>.md`. This used to be
   * `<repo>/agent` — a directory this project does not have — so the prompt
   * endpoint answered 404 for every agent that has ever existed.
   */
  agentsDir: join(harnessDir(PROJECT_ROOT), 'agents'),
  token: process.env['DASHBOARD_TOKEN'] ?? '',
  allowedOrigin: process.env['ALLOWED_ORIGIN'] ?? '',
  fallbackProfileId: process.env['HARNESS_PROFILE'] ?? '',
});

serve({
  port: PORT,
  hostname: BIND_HOST,
  idleTimeout: 0,
  fetch: (req) => dashboard.fetch(req),
});

dashboard.start();

log('info', `Dashboard: http://${BIND_HOST}:${PORT}`);
