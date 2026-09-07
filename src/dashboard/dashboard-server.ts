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
import { readFileSync, existsSync, statSync, watch } from 'node:fs';
import { buildDashboardSchema } from './dashboard-contract.ts';
import { getIssue, postComment } from './beads-bridge.ts';
import { sessionsDir, opencodeStateDir, profilesDir } from '../app/paths.ts';
import { readAllSessions, readSession, resolveConfig } from '../public-api.ts';
import { selectSchema, schemaToEngineConfig } from '../app/mutation-orchestrator.ts';
import { compileWorkflow } from '../schema/compile-workflow.ts';

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(join(import.meta.dir, '..', '..'));

/**
 * Where profiles live, by the same rule the plugin uses:
 * `STATE_MACHINE_PROFILES_DIR` when the operator sets it, otherwise the
 * project's own `.opencode/profiles`. This repository keeps its shipped
 * profiles in `profiles/` and is not itself a governed project, so running the
 * dashboard here wants the override.
 */
const PROFILES_DIR = profilesDir(PROJECT_ROOT);

/**
 * The store the plugin actually writes to.
 *
 * This was hardcoded to `<repo>/.opencode/state-machine/sessions`, a path
 * nothing has written since the store moved out of the project — so the
 * dashboard read an empty directory and showed no sessions while the plugin
 * was running. `sessionsDir` is the same rule the plugin and the TUI use:
 * STATE_MACHINE_STORE_DIR when set, otherwise OpenCode's own state directory.
 */
const SESSIONS_DIR = sessionsDir(opencodeStateDir());
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

/**
 * Every session the store holds, keyed by id.
 *
 * This used to read the directory itself, falling back on a map of previously
 * seen sessions when a file would not parse. The fallback was worse than the
 * gap it filled: it recorded only the *first* snapshot it ever saw of a
 * session and never updated it, so a corrupt file was answered with the
 * session as it looked when the dashboard started. A monitor that hides a
 * broken session behind a stale copy of itself is lying about the thing it
 * exists to show.
 */
async function loadAllSessions(): Promise<Record<string, unknown>> {
  return readAllSessions(SESSIONS_DIR);
}

/**
 * The profile and schema to describe when the caller names neither.
 *
 * The most recently updated session: whichever workflow is being worked on is
 * the one an operator opening the dashboard means.
 */
async function newestSessionProfile(): Promise<{ profileId: string; schemaId?: string } | null> {
  let newest: { updatedAt: string; profileId: string; schemaId?: string } | null = null;
  for (const value of Object.values(await loadAllSessions())) {
    const session = value as Record<string, unknown> | undefined;
    const profileId = session?.['profileId'];
    if (typeof profileId !== 'string' || profileId === '') continue;
    const updatedAt = typeof session?.['updatedAt'] === 'string' ? session['updatedAt'] : '';
    const schemaId = typeof session?.['schemaId'] === 'string' ? session['schemaId'] : undefined;
    if (!newest || updatedAt > newest.updatedAt) newest = { updatedAt, profileId, schemaId };
  }
  return newest ? { profileId: newest.profileId, schemaId: newest.schemaId } : null;
}

/**
 * Describe a real, compiled workflow.
 *
 * This endpoint used to answer from a list of stages and edges written into
 * this file, and `stageOf` used to measure every session against a *second*,
 * different hardcoded copy a few lines above it. The two disagreed with each
 * other — one had a `validation` stage, the other did not — and both had
 * drifted from `profiles/base/base.yaml`. Neither failed when it drifted,
 * because nothing compared them to anything.
 *
 * Now the profile is resolved and compiled exactly as the plugin resolves it,
 * so the answer is the workflow a session is running or it is an honest 404.
 */
async function describeWorkflow(wanted: {
  profileId?: string;
  schemaId?: string;
}): Promise<ReturnType<typeof buildDashboardSchema> | { failure: string } | null> {
  const target = wanted.profileId
    ? { profileId: wanted.profileId, schemaId: wanted.schemaId }
    : ((await newestSessionProfile()) ?? {
        profileId: process.env['HARNESS_PROFILE'] ?? '',
        schemaId: wanted.schemaId,
      });
  if (!target.profileId) return null;

  try {
    const resolved = await resolveConfig(target.profileId, PROFILES_DIR);
    const selected = selectSchema(target.profileId, resolved.schemas, target.schemaId);
    const { workflow } = compileWorkflow({
      id: selected.id,
      source: selected.source,
      ...schemaToEngineConfig(selected),
    });

    return buildDashboardSchema({
      stages: Object.keys(workflow.stages),
      transitions: workflow.transitions.map((t) => ({ from: t.from, to: t.to })),
      gates: (selected.gates ?? []).map((gate) => ({ id: gate.id })),
      profile: {
        id: resolved.metadata.id,
        // A profile carries no version of its own; the schema it runs names it.
        version: selected.id,
        description: resolved.metadata.description ?? '',
        invariants: resolved.metadata.invariants ?? [],
        // What the workflow waits on before it may deliver.
        mandatoryStages: selected.requiredGates ?? [],
        agents: resolved.metadata.agents ?? [],
        skills: resolved.metadata.skills ?? [],
      },
    });
  } catch (error) {
    // Why it could not be described is the useful half of the answer. A bare
    // 404 here reads as "no such thing" when the truth may be a profile
    // directory that does not exist or a schema that does not compile.
    return {
      failure: `Could not describe ${target.profileId}${target.schemaId ? `/${target.schemaId}` : ''} from ${PROFILES_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function loadSession(id: string): Promise<unknown | null> {
  return readSession(SESSIONS_DIR, id);
}

// ─── Session helpers ─────────────────────────────────────────────────────────

interface EnrichedSession {
  stage: string;
  [key: string]: unknown;
}

/**
 * The stage the session is in — read, not re-derived.
 *
 * This used to run `deriveStage` over a hardcoded copy of the base workflow
 * kept in this file, which had drifted: no `validation` stage, an
 * `execution → planning` edge no profile declares, and the `revision == 0`
 * escape hatch the profile corpus deliberately removed. Every session of every
 * other profile was measured against it.
 *
 * The engine already derived the stage and the runtime persisted the answer to
 * `currentStage`. Reading that field is seeing the engine's answer; anything
 * else here is a second opinion from a workflow nobody is running.
 */
function stageOf(session: Record<string, unknown>): string {
  const stage = session['currentStage'];
  return typeof stage === 'string' && stage !== '' ? stage : 'UNKNOWN';
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
        async start(c) {
          controller = c;
          clients.add(controller);
          controller.enqueue(`data: ${JSON.stringify({ snapshot: await loadAllSessions() })}\n\n`);
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

    // GET /api/schema — the workflow a session is actually running.
    if (url.pathname === '/api/schema') {
      const wanted = {
        profileId: url.searchParams.get('profile') ?? undefined,
        schemaId: url.searchParams.get('schema') ?? undefined,
      };
      const schema = await describeWorkflow(wanted);
      if (!schema || 'failure' in schema) {
        return new Response(
          JSON.stringify({
            error:
              schema && 'failure' in schema
                ? schema.failure
                : 'No workflow to describe. Name one with ?profile=<id>&schema=<id>, or create a session.',
          }),
          {
            status: 404,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders(req.headers.get('Origin')),
            },
          }
        );
      }
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
      const session = await loadSession(id);
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
      return new Response(JSON.stringify(await loadAllSessions(), null, 2), {
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
      const session = await loadSession(id);
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
      const session = await loadSession(id);
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

/**
 * Publish what changed since the last look: the diff events, then the sessions.
 *
 * The watcher and the poller ran the same read-compare-write inline, which was
 * safe only while the read was synchronous. Reading is async now, so two runs
 * can overlap: both would compare against the same `lastSnapshot` and emit the
 * same events twice. `publishing` makes a second run wait its turn rather than
 * race the first.
 *
 * The snapshot is pushed alongside the events because an event alone does not
 * update the page. The client keeps its session map from `snapshot` messages;
 * a `transition` event says a stage changed but carries no session to put in
 * the map.
 */
let lastSnapshot = '{}';
let publishing = false;

async function publishChanges(): Promise<void> {
  if (publishing) return;
  publishing = true;
  try {
    const newSessions = await loadAllSessions();
    const current = JSON.stringify(newSessions);
    if (current === lastSnapshot) return;

    const oldSessions = JSON.parse(lastSnapshot) as Record<string, unknown>;
    const ts = Math.floor(Date.now() / 1000);
    for (const event of diffSessions(oldSessions, newSessions, ts)) {
      pushEventToAll(event);
    }
    lastSnapshot = current;
    pushToAll({ snapshot: newSessions });
  } finally {
    publishing = false;
  }
}

try {
  // `watch` throws on a directory that does not exist yet — no session has
  // ever been written on this machine — and that is not a reason to take the
  // dashboard down with it. The catch below already reports it.
  watch(SESSIONS_DIR, (_event, filename) => {
    if (filename && filename.endsWith('.json')) void publishChanges();
  });
  console.log('File watcher active (fs.watch)');
} catch {
  console.log('File watcher unavailable, using polling');
}

// Polling every 500ms
setInterval(() => void publishChanges(), 500);

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
