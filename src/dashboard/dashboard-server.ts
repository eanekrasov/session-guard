/* eslint-disable no-console */

/**
 * Dashboard Standalone Server
 * Запуск: bun run src/dashboard/dashboard-server.ts
 *
 * Работает как ОТДЕЛЬНЫЙ процесс (не внутри плагина OpenCode).
 * Читает .opencode/state-machine/sessions/*.json и раздаёт SSE + HTML + API.
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
import { readFileSync, existsSync, readdirSync, statSync, watch } from 'node:fs';
import { buildDashboardSchema } from './dashboard-contract.ts';
import type { WorkflowSession } from '../session/session-schema.ts';
import { StateMachineEngine } from '../domain/engine.ts';
import type { EngineConfig } from '../domain/engine.ts';
import { getIssue, postComment } from './beads-bridge.ts';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * The gates the base workflow declares, for the static `/api/schema` reply.
 *
 * That endpoint describes a workflow, not a session, and it already hardcodes
 * its stages and transitions rather than loading the running profile. This is
 * the same placeholder at the same fidelity — sessions themselves now carry no
 * gate list to read.
 */
const BASE_WORKFLOW_GATES = ['invariants', 'review', 'qa'] as const;

const SESSIONS_DIR = join(import.meta.dir, '..', '..', '.opencode', 'state-machine', 'sessions');
const OPENCODE_ROOT = resolve(join(import.meta.dir, '..', '..', '.opencode'));
const AGENT_DIR = resolve(join(import.meta.dir, '..', '..', 'agent'));

const DASHBOARD_TOKEN = process.env['DASHBOARD_TOKEN'] ?? '';
const BIND_HOST = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';
const ALLOWED_ORIGIN = process.env['ALLOWED_ORIGIN'] ?? '';

interface TimelineEvent {
  id: string;
  type: 'transition' | 'gate' | 'metric';
  ts: number;
  data: Record<string, unknown>;
}

interface InvariantViolation {
  id: string;
  severity: 'error' | 'warning';
  file: string;
  message: string;
  ts: number;
}

const ALLOWED_AGENTS = new Set([
  'orchestrator',
  'code',
  'architect',
  'review',
  'qa',
  'debug',
  'figma',
  'rag',
  'ask',
  'harness',
]);

type SSEClient = ReadableStreamDefaultController;
const clients = new Set<SSEClient>();

// ─── Auth & CORS ─────────────────────────────────────────────────────────────

function checkAuth(req: Request): Response | null {
  if (!DASHBOARD_TOKEN) return null;
  const header = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const token = header.slice(7);
  if (token !== DASHBOARD_TOKEN) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!ALLOWED_ORIGIN || !origin) return {};
  if (origin !== ALLOWED_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    Vary: 'Origin',
  };
}

// ─── Session loading ─────────────────────────────────────────────────────────

const prevSessions: Map<string, unknown> = new Map();

function loadAllSessions(): Record<string, unknown> {
  const sessions: Record<string, unknown> = {};
  if (!existsSync(SESSIONS_DIR)) return sessions;
  for (const entry of readdirSync(SESSIONS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const id = decodeURIComponent(entry.replace('.json', ''));
    try {
      const raw = readFileSync(join(SESSIONS_DIR, entry), 'utf-8');
      const parsed = JSON.parse(raw);
      sessions[id] = parsed;
      if (!prevSessions.has(id)) {
        prevSessions.set(id, parsed);
      }
    } catch {
      sessions[id] = prevSessions.get(id);
    }
  }
  return sessions;
}

function loadSession(id: string): unknown | null {
  const filePath = join(SESSIONS_DIR, `${encodeURIComponent(id)}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── Engine (default config for deriveStage) ────────────────────────────────

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  stageAssignments: [
    { id: 'default', priority: 0, condition: 'true', result: 'planning' },
    {
      id: 'hasPlanApproval',
      priority: 60,
      condition: "session.approved('plan')",
      result: 'tasks_ready',
    },
    {
      id: 'uncommitted',
      priority: 70,
      condition:
        "session.approved('plan') && (session.tasks.implementation ?? []).length > 0 && session.tasks.implementation.some(t => t.status != 'completed')",
      result: 'execution',
    },
    {
      id: 'commitApproval',
      priority: 90,
      condition: "session.approved('commit')",
      result: 'commit',
    },
    {
      id: 'deliveryReceipt',
      priority: 100,
      condition:
        "typeof session.deliveryReceipt == 'string' || typeof session.deliveryPermit == 'string'",
      result: 'done',
    },
  ],
  transitions: [
    { from: 'planning', to: 'tasks_ready', guard: "session.approved('plan')" },
    {
      from: 'tasks_ready',
      to: 'execution',
      guard:
        "(session.tasks.implementation ?? []).length > 0 && session.tasks.implementation.some(t => t.status != 'completed')",
    },
    { from: 'execution', to: 'execution', kind: 'auto' },
    { from: 'execution', to: 'commit', kind: 'pass' },
    { from: 'execution', to: 'planning', guard: "!session.approved('plan')" },
    { from: 'commit', to: 'done', guard: "typeof session.deliveryReceipt == 'string'" },
  ],
  actionGuards: {
    beginMutation: "session.approved('plan') || session.revision == 0",
  },
  requiredGates: ['invariants', 'review', 'qa'],
};

const _engine = new StateMachineEngine(DEFAULT_ENGINE_CONFIG);

// ─── Session helpers ─────────────────────────────────────────────────────────

interface EnrichedSession {
  stage: string;
  [key: string]: unknown;
}

function stageOf(session: Record<string, unknown>): string {
  try {
    return _engine.deriveStage(session as unknown as WorkflowSession);
  } catch {
    return 'UNKNOWN';
  }
}

function gatesOf(session: Record<string, unknown>): Record<string, string> {
  const gates = Array.isArray(session['gates'])
    ? (session['gates'] as Array<Record<string, unknown>>)
    : [];
  const result: Record<string, string> = {};
  for (const g of gates) {
    if (typeof g['id'] === 'string' && typeof g['status'] === 'string') {
      result[g['id']] = g['status'];
    }
  }
  return result;
}

function buildTimeline(session: Record<string, unknown>): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const revision = (session['revision'] as number) ?? 0;
  const updatedAt = session['updatedAt'];
  for (const [gate, status] of Object.entries(gatesOf(session))) {
    if (status && status !== 'pending') {
      events.push({
        id: `gate-${gate}-${revision}`,
        type: 'gate',
        ts: updatedAt ? new Date(updatedAt as string).getTime() : Date.now(),
        data: { gate, status },
      });
    }
  }
  return events;
}

function buildInvariants(session: Record<string, unknown>): InvariantViolation[] {
  const records = (session['invariantViolations'] as unknown[]) ?? [];
  const violations: InvariantViolation[] = [];
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e['evidenceId'] === 'string' && typeof e['status'] === 'string') {
      violations.push({
        id: e['evidenceId'],
        severity: e['severity'] === 'critical' ? 'error' : 'warning',
        file: typeof e['file'] === 'string' ? e['file'] : '',
        message: typeof e['message'] === 'string' ? e['message'] : 'invariant violated',
        ts: e['createdAt'] ? new Date(e['createdAt'] as string).getTime() : Date.now(),
      });
    }
  }
  return violations;
}

function enrichSession(session: unknown): EnrichedSession | null {
  if (!session || typeof session !== 'object') return null;
  const s = session as Record<string, unknown>;
  return {
    ...s,
    stage: stageOf(s),
  } as EnrichedSession;
}

function diffSessions(
  oldSessions: Record<string, unknown>,
  newSessions: Record<string, unknown>,
  now: number
): unknown[] {
  const events: unknown[] = [];
  for (const [sessionId, newSessionRaw] of Object.entries(newSessions)) {
    const newSession = newSessionRaw as Record<string, unknown>;
    const oldSession = oldSessions[sessionId] as Record<string, unknown> | undefined;
    if (!oldSession) continue;

    const oldState = stageOf(oldSession);
    const newState = stageOf(newSession);
    if (oldState !== newState) {
      events.push({
        type: 'transition',
        sessionId,
        from: oldState,
        to: newState,
        ts: now,
      });
    }

    const oldGates = gatesOf(oldSession);
    const newGates = gatesOf(newSession);
    for (const [gate, status] of Object.entries(newGates)) {
      if (oldGates[gate] !== status) {
        events.push({
          type: 'gate',
          sessionId,
          gate,
          status,
          ts: now,
        });
      }
    }
  }
  return events;
}

// ─── SSE push ────────────────────────────────────────────────────────────────

function pushToAll(data: unknown): void {
  const json = JSON.stringify(data);
  for (const client of clients) {
    try {
      client.enqueue(`data: ${json}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

function pushEventToAll(event: unknown): void {
  pushToAll(event);
}

// ─── Metrics & RAG ───────────────────────────────────────────────────────────

function readMetrics(): unknown {
  const metricsPath = join(OPENCODE_ROOT, 'metrics.jsonl');
  if (!existsSync(metricsPath)) return null;
  try {
    const raw = readFileSync(metricsPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const records: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.ts === 'string' && typeof parsed.task === 'string') {
          records.push(parsed);
        }
      } catch {
        /* skip */
      }
    }
    const byAgent: Record<string, { count: number; totalDur: number }> = {};
    let totalDur = 0;
    for (const r of records) {
      const agent = String(r.agent || 'unknown');
      const dur = typeof r.dur === 'number' ? r.dur : 0;
      if (!byAgent[agent]) byAgent[agent] = { count: 0, totalDur: 0 };
      byAgent[agent].count++;
      byAgent[agent].totalDur += dur;
      totalDur += dur;
    }
    return {
      records,
      aggregates: {
        byAgent,
        totalDuration: +totalDur.toFixed(1),
        count: records.length,
      },
    };
  } catch {
    return null;
  }
}

function readRagEval(): unknown {
  const evalPath = join(OPENCODE_ROOT, 'rag', 'eval-results.json');
  if (!existsSync(evalPath)) return null;
  try {
    return JSON.parse(readFileSync(evalPath, 'utf-8'));
  } catch {
    return null;
  }
}

function readAgentPrompt(agentId: string): { content: string } | null {
  if (!ALLOWED_AGENTS.has(agentId)) return null;
  const filePath = resolve(AGENT_DIR, `${agentId}.md`);
  if (filePath !== join(AGENT_DIR, `${agentId}.md`)) return null;
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return { content };
  } catch {
    return null;
  }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const htmlPath = join(import.meta.dir, 'dashboard.html');
let dashboardHtml = '<h1>Dashboard</h1><p>HTML not found</p>';
try {
  dashboardHtml = readFileSync(htmlPath, 'utf-8');
} catch {
  /* use fallback */
}

// ─── Server ───────────────────────────────────────────────────────────────────

serve({
  port: 3456,
  hostname: BIND_HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // Auth for API endpoints
    const apiPaths = [
      '/api/schema',
      '/api/session',
      '/api/dump',
      '/api/metrics',
      '/api/rag-eval',
      '/api/agents',
      '/api/beads',
      '/events',
    ];
    if (apiPaths.some((p) => url.pathname.startsWith(p))) {
      const authError = checkAuth(req);
      if (authError) return authError;
    }

    // SSE
    if (url.pathname === '/events') {
      let controller: SSEClient;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
          clients.add(controller);
          controller.enqueue(`data: ${JSON.stringify({ snapshot: loadAllSessions() })}\n\n`);
        },
        cancel() {
          clients.delete(controller!);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/schema
    if (url.pathname === '/api/schema') {
      const schema = buildDashboardSchema({
        stages: ['planning', 'tasks_ready', 'execution', 'commit', 'done'],
        transitions: [
          { from: 'planning', to: 'tasks_ready' },
          { from: 'tasks_ready', to: 'execution' },
          { from: 'execution', to: 'commit' },
          { from: 'commit', to: 'done' },
        ],
        gates: BASE_WORKFLOW_GATES.map((id) => ({ id })),
        profile: {
          id: process.env['HARNESS_PROFILE'] ?? 'base',
          version: '1.0',
          description: 'State machine workflow',
          invariants: [],
          mandatoryStages: [...BASE_WORKFLOW_GATES],
          agents: [],
          skills: [],
        },
      });
      return new Response(JSON.stringify(schema, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/session/:id
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const session = loadSession(id);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const enriched = enrichSession(session);
      return new Response(JSON.stringify(enriched, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // HTML dashboard (same-origin, no CORS)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(dashboardHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // GET /api/dump
    if (url.pathname === '/api/dump') {
      return new Response(JSON.stringify(loadAllSessions(), null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/session/:id/timeline
    const timelineMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/timeline$/);
    if (timelineMatch) {
      const id = timelineMatch[1];
      const session = loadSession(id);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const timeline = buildTimeline(session as Record<string, unknown>);
      return new Response(JSON.stringify(timeline, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/session/:id/invariants
    const invariantsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/invariants$/);
    if (invariantsMatch) {
      const id = invariantsMatch[1];
      const session = loadSession(id);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const invariants = buildInvariants(session as Record<string, unknown>);
      return new Response(JSON.stringify(invariants, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/metrics
    if (url.pathname === '/api/metrics') {
      const metrics = readMetrics();
      return new Response(JSON.stringify(metrics, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/rag-eval
    if (url.pathname === '/api/rag-eval') {
      const ragEval = readRagEval();
      return new Response(JSON.stringify(ragEval, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/agents/:id/prompt
    const agentPromptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
    if (agentPromptMatch) {
      const agentId = agentPromptMatch[1];
      if (!ALLOWED_AGENTS.has(agentId)) {
        return new Response(JSON.stringify({ error: 'Unknown agent' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const prompt = readAgentPrompt(agentId);
      if (!prompt) {
        return new Response(JSON.stringify({ error: 'Prompt not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(prompt, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // GET /api/beads/issue/:id
    const beadsIssueMatch = url.pathname.match(/^\/api\/beads\/issue\/([^/]+)$/);
    if (beadsIssueMatch) {
      const issueId = beadsIssueMatch[1];
      const issue = await getIssue(issueId);
      return new Response(JSON.stringify(issue, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(req.headers.get('Origin')),
        },
      });
    }

    // POST /api/beads/comment
    if (url.pathname === '/api/beads/comment' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { issueId?: string; text?: string; author?: string };
        if (!body.issueId || !body.text || !body.author) {
          return new Response(
            JSON.stringify({ error: 'Missing required fields: issueId, text, author' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        await postComment(body.issueId, body.text, body.author);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(req.headers.get('Origin')),
          },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Dashboard: http://${BIND_HOST}:3456`);

// ─── File watcher: incremental SSE updates ───────────────────────────────────

let lastSnapshot = JSON.stringify(loadAllSessions());

try {
  watch(SESSIONS_DIR, (_event, filename) => {
    if (filename && filename.endsWith('.json')) {
      const current = JSON.stringify(loadAllSessions());
      if (current !== lastSnapshot) {
        const oldSessions = JSON.parse(lastSnapshot) as Record<string, unknown>;
        const newSessions = JSON.parse(current) as Record<string, unknown>;
        const ts = Math.floor(Date.now() / 1000);
        const events = diffSessions(oldSessions, newSessions, ts);

        if (events.length > 0) {
          for (const event of events) {
            pushEventToAll(event);
          }
        }
        lastSnapshot = current;
      }
    }
  });
  console.log('File watcher active (fs.watch)');
} catch {
  console.log('File watcher unavailable, using polling');
}

// Polling every 500ms
setInterval(() => {
  const current = JSON.stringify(loadAllSessions());
  if (current !== lastSnapshot) {
    const oldSessions = JSON.parse(lastSnapshot) as Record<string, unknown>;
    const newSessions = JSON.parse(current) as Record<string, unknown>;
    const ts = Math.floor(Date.now() / 1000);
    const events = diffSessions(oldSessions, newSessions, ts);

    if (events.length > 0) {
      for (const event of events) {
        pushEventToAll(event);
      }
    }
    lastSnapshot = current;
  }
}, 500);

console.log('Polling every 500ms');

// Metrics file watcher + polling
let lastMetricsMtime = 0;
function checkMetricsChanges(): void {
  const metricsPath = join(OPENCODE_ROOT, 'metrics.jsonl');
  if (!existsSync(metricsPath)) return;
  try {
    const s = statSync(metricsPath);
    const mtime = s.mtimeMs;
    if (mtime !== lastMetricsMtime) {
      lastMetricsMtime = mtime;
      pushEventToAll({
        type: 'metric',
        ts: Math.floor(Date.now() / 1000),
        data: { updated: true },
      });
    }
  } catch {
    /* skip */
  }
}
setInterval(checkMetricsChanges, 2000);
