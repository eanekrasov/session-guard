#!/usr/bin/env bun
/**
 * Dashboard Standalone Server
 * Запуск: bun run packages/dashboard/src/dashboard-server.ts
 *
 * Работает как ОТДЕЛЬНЫЙ процесс (не внутри плагина OpenCode).
 * Получает сессии и профили через session-guard CLI и раздаёт SSE + HTML + API.
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
import { createSessionGuardCommand } from './session-guard-cli.ts';

const PROJECT_ROOT = resolve(process.env['DASHBOARD_PROJECT_ROOT'] ?? process.cwd());

const BIND_HOST = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';
const PORT = 3456;
const CLI = process.env['SESSION_GUARD_CLI']
  ? [process.execPath, process.env['SESSION_GUARD_CLI']]
  : ['session-guard'];
const harnessRoot = process.env['OPENCODE_HARNESS_DIR'] ?? join(PROJECT_ROOT, '.opencode');

const dashboard = createDashboard({
  sessionGuard: createSessionGuardCommand(CLI, { cwd: PROJECT_ROOT }),
  projectRoot: PROJECT_ROOT,
  opencodeRoot: resolve(join(PROJECT_ROOT, '.opencode')),
  agentsDir: join(harnessRoot, 'agents'),
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
process.stdout.write(`Dashboard: http://${BIND_HOST}:${PORT}\n`);
