/**
 * The dashboard, as something you can hold.
 *
 * This used to be one file that started a server, a file watcher and two
 * timers the moment it was imported, and that read its store, profile, agent
 * and metrics directories into module constants at import time. Nothing in it
 * was exported. A test could neither call a handler nor say where it should
 * look, so the only assertions anyone could write about the dashboard were
 * string matches against its own source — which then broke whenever a comment
 * mentioned the wrong word.
 *
 * Every path is an argument here, and nothing runs until `start()`. The entry
 * point reads the environment and hands the result to `createDashboard`.
 */

import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboardSchema } from './dashboard-contract.ts';
import { getIssue, postComment } from './beads-bridge.ts';
import {
  archiveDirOf,
  getCurrentStageGates,
  listProfileAgents,
  readAllSessions,
  readSession,
  resolveConfig,
} from '../public-api.ts';
import { selectSchema, schemaToEngineConfig } from '../app/mutation-orchestrator.ts';
import { noopLog, type LogFn } from '../app/logger.ts';
import { compileWorkflow } from '../schema/compile-workflow.ts';
import type { StageDef } from '../schema/profile-schema.ts';
import type { WorkflowSession } from '../session/session-schema.ts';
import { toSessionSnapshot, type SessionSnapshot } from '../types';

function gateIdsFromStages(stages: Record<string, StageDef> | undefined): string[] {
  const ids = new Set<string>();
  const visit = (stage: StageDef): void => {
    for (const gate of stage.gates ?? []) ids.add(gate);
    for (const nested of Object.values(stage.stages ?? {})) visit(nested);
  };
  for (const stage of Object.values(stages ?? {})) visit(stage);
  return [...ids];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface DashboardConfig {
  /** Where the plugin writes sessions. */
  sessionsDir: string;
  /** Where profiles live, by the same rule the plugin uses. */
  profilesDir: string;
  /** The project's `.opencode`, holding `metrics.jsonl` and `rag/`. */
  opencodeRoot: string;
  /**
   * The root the profile agent sync writes into — `<harness>/agents`.
   *
   * A profile's agents are copied to `<harness>/agents/<profileId>_<agent>.md`
   * — one flat directory, with the profile in the file name. It used to point
   * at `<repo>/agent`, a directory that does not exist in this project at all,
   * which is why the prompt endpoint has always answered 404.
   */
  agentsDir: string;
  /** The page to serve at `/`. Defaults to the one shipped beside this file. */
  htmlPath?: string;
  /** When set, every API path requires `Authorization: Bearer <token>`. */
  token?: string;
  /** The single origin CORS headers are emitted for. */
  allowedOrigin?: string;
  /** The profile to describe when no session names one. */
  fallbackProfileId?: string;
  /**
   * Where the dashboard reports what it is doing.
   *
   * A port, not a console call: the dashboard is embedded in tests and in the
   * standalone process alike, and only the composition root decides which
   * surface those records land on. Defaults to discarding them.
   */
  log?: LogFn;
}

export interface Dashboard {
  /** Answer one request. The whole HTTP surface, without a listening socket. */
  fetch(req: Request): Promise<Response>;
  /** Read the store and push what changed to connected clients. */
  publishChanges(): Promise<void>;
  /** Begin watching the store and polling it. */
  start(): void;
  /** Stop watching, and drop every connected client. */
  stop(): void;
}

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

interface EnrichedSession {
  stage: string;
  [key: string]: unknown;
}

// ─── Session helpers ─────────────────────────────────────────────────────────

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
export function stageOf(session: SessionSnapshot): string {
  const stage = session.currentStage;
  return typeof stage === 'string' && stage !== '' ? stage : 'UNKNOWN';
}

export function gatesOf(session: SessionSnapshot): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [gate, status] of Object.entries(session.gates)) {
    result[gate] = status;
  }
  return result;
}

export function buildTimeline(session: SessionSnapshot): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const revision = session.revision ?? 0;
  const updatedAt = session.updatedAt;
  for (const [gate, status] of Object.entries(gatesOf(session))) {
    if (status && status !== 'pending') {
      events.push({
        id: `gate-${gate}-${revision}`,
        type: 'gate',
        ts: updatedAt ? new Date(updatedAt).getTime() : Date.now(),
        data: { gate, status },
      });
    }
  }
  return events;
}

export function buildInvariants(session: SessionSnapshot): InvariantViolation[] {
  const records = session.invariantViolations ?? [];
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

function enrichSession(session: SessionSnapshot | null): EnrichedSession | null {
  if (!session) return null;
  return { ...session, stage: stageOf(session) } as EnrichedSession;
}

export function diffSessions(
  oldSessions: Record<string, SessionSnapshot>,
  newSessions: Record<string, SessionSnapshot>,
  now: number
): unknown[] {
  const events: unknown[] = [];
  for (const [sessionId, newSession] of Object.entries(newSessions)) {
    const oldSession = oldSessions[sessionId];
    if (!oldSession) continue;

    const oldState = stageOf(oldSession);
    const newState = stageOf(newSession);
    if (oldState !== newState) {
      events.push({ type: 'transition', sessionId, from: oldState, to: newState, ts: now });
    }

    const oldGates = gatesOf(oldSession);
    const newGates = gatesOf(newSession);
    for (const [gate, status] of Object.entries(newGates)) {
      if (oldGates[gate] !== status) {
        events.push({ type: 'gate', sessionId, gate, status, ts: now });
      }
    }
  }
  return events;
}

// ─── The dashboard ───────────────────────────────────────────────────────────

export function createDashboard(config: DashboardConfig): Dashboard {
  const {
    sessionsDir,
    profilesDir,
    opencodeRoot,
    agentsDir,
    htmlPath = fileURLToPath(new URL('dashboard.html', import.meta.url)),
    token = '',
    allowedOrigin = '',
    fallbackProfileId = '',
    log = noopLog,
  } = config;

  type SSEClient = ReadableStreamDefaultController;
  const clients = new Set<SSEClient>();

  let dashboardHtml = '<h1>Dashboard</h1><p>HTML not found</p>';
  try {
    dashboardHtml = readFileSync(htmlPath, 'utf-8');
  } catch {
    /* use fallback */
  }

  // ── Auth & CORS ──────────────────────────────────────────────────────────

  function checkAuth(req: Request): Response | null {
    if (!token) return null;
    const header = req.headers.get('Authorization') ?? req.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (header.slice(7) !== token) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return null;
  }

  function corsHeaders(origin: string | null): Record<string, string> {
    if (!allowedOrigin || !origin) return {};
    if (origin !== allowedOrigin) return {};
    return { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' };
  }

  function json(body: unknown, req: Request, status = 200): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(req.headers.get('Origin')),
      },
    });
  }

  // ── Session loading ──────────────────────────────────────────────────────

  /**
   * Every session the store holds, keyed by id.
   *
   * This used to read the directory itself, falling back on a map of
   * previously seen sessions when a file would not parse. The fallback was
   * worse than the gap it filled: it recorded only the *first* snapshot it
   * ever saw of a session and never updated it, so a corrupt file was answered
   * with the session as it looked when the dashboard started. A monitor that
   * hides a broken session behind a stale copy of itself is lying about the
   * thing it exists to show.
   */
  /**
   * Рантайм и архив вместе.
   *
   * Законченная сессия уезжает из рантайма в `archive/`: с этого момента она
   * ничем не управляет, и «сессии нет» выражается отсутствием файла там, где
   * его ищет `load`. Но монитор существует, чтобы показывать итог, и потерять
   * из виду именно завершившуюся работу — ровно наоборот его назначению.
   *
   * Рантайм читается последним: пока сессия жива, её текущее состояние важнее
   * любой одноимённой записи в архиве.
   */
  async function loadAllSessions(): Promise<Record<string, WorkflowSession>> {
    const archiveSessions = await readAllSessions(archiveDirOf(sessionsDir));
    const activeSessions = await readAllSessions(sessionsDir);
    return { ...archiveSessions, ...activeSessions };
  }

  async function loadSession(id: string): Promise<WorkflowSession | null> {
    return (
      (await readSession(sessionsDir, id)) ?? (await readSession(archiveDirOf(sessionsDir), id))
    );
  }

  /**
   * The profile and schema to describe when the caller names neither.
   *
   * The most recently updated session: whichever workflow is being worked on
   * is the one an operator opening the dashboard means.
   */
  async function newestSessionProfile(): Promise<{
    profileId: string;
    schemaId?: string;
  } | null> {
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
   */
  async function describeWorkflow(wanted: {
    profileId?: string;
    schemaId?: string;
  }): Promise<ReturnType<typeof buildDashboardSchema> | { failure: string } | null> {
    const target = wanted.profileId
      ? { profileId: wanted.profileId, schemaId: wanted.schemaId }
      : ((await newestSessionProfile()) ?? {
          profileId: fallbackProfileId,
          schemaId: wanted.schemaId,
        });
    if (!target.profileId) return null;

    try {
      const resolved = await resolveConfig(target.profileId, profilesDir);
      const selected = selectSchema(target.profileId, resolved.schemas, target.schemaId);
      const { workflow } = compileWorkflow({
        id: selected.id,
        source: selected.source,
        ...schemaToEngineConfig(selected),
      });

      return buildDashboardSchema({
        stages: Object.keys(workflow.stages),
        transitions: workflow.transitions.map((t) => ({ from: t.from, to: t.to })),
        gates: gateIdsFromStages(selected.stages).map((id) => ({ id })),
        profile: {
          id: resolved.metadata.id,
          // A profile carries no version of its own; the schema it runs names it.
          version: selected.id,
          description: resolved.metadata.description ?? '',
          invariants: resolved.metadata.invariants ?? [],
          // What the workflow waits on before it may deliver.
          agents: resolved.metadata.agents ?? [],
          skills: resolved.metadata.skills ?? [],
        },
      });
    } catch (error) {
      // Why it could not be described is the useful half of the answer. A bare
      // 404 here reads as "no such thing" when the truth may be a profile
      // directory that does not exist or a schema that does not compile.
      return {
        failure: `Could not describe ${target.profileId}${target.schemaId ? `/${target.schemaId}` : ''} from ${profilesDir}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ── Metrics, RAG, prompts ────────────────────────────────────────────────

  function readMetrics(): unknown {
    const metricsPath = join(opencodeRoot, 'metrics.jsonl');
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
        aggregates: { byAgent, totalDuration: +totalDur.toFixed(1), count: records.length },
      };
    } catch {
      return null;
    }
  }

  function readRagEval(): unknown {
    const evalPath = join(opencodeRoot, 'rag', 'eval-results.json');
    if (!existsSync(evalPath)) return null;
    try {
      return JSON.parse(readFileSync(evalPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * One agent's prompt, as the profile ships it.
   *
   * `resolve` is compared against `join` so a segment climbing out of the
   * directory with `..` names nothing. Both halves of the file name are
   * attacker-shaped input, so the check covers the composed name.
   */
  function readAgentPrompt(profileId: string, agentId: string): { content: string } | null {
    const expected = join(agentsDir, `${profileId}_${agentId}.md`);
    if (resolve(expected) !== expected) return null;
    if (!existsSync(expected)) return null;
    try {
      return { content: readFileSync(expected, 'utf-8') };
    } catch {
      return null;
    }
  }

  // ── SSE ──────────────────────────────────────────────────────────────────

  // An HTTP body is bytes. Enqueuing the string worked only because Bun's
  // server encodes it on the way out; anything else reading the stream — a
  // test, another host — got a string where it asked for a chunk.
  const encoder = new TextEncoder();

  function frame(data: unknown): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  function pushToAll(data: unknown): void {
    const payload = frame(data);
    for (const client of clients) {
      try {
        client.enqueue(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  /**
   * Publish what changed since the last look: the diff events, then the sessions.
   *
   * The watcher and the poller ran the same read-compare-write inline, which
   * was safe only while the read was synchronous. Reading is async now, so two
   * runs can overlap: both would compare against the same snapshot and emit
   * the same events twice. `publishing` makes a second run stand down rather
   * than race the first.
   *
   * The snapshot goes out alongside the events because an event alone does not
   * update the page. The client keeps its session map from `snapshot`
   * messages; a `transition` event says a stage changed but carries no session
   * to put in the map.
   */
  let lastSnapshot = '{}';
  let publishing = false;

  async function publishChanges(): Promise<void> {
    if (publishing) return;
    publishing = true;
    try {
      const newSessions = await loadAllSessions();
      const newSessionsSnapshots: Record<string, SessionSnapshot> = {};
      for (const [id, session] of Object.entries(newSessions)) {
        newSessionsSnapshots[id] = toSessionSnapshot(session);
      }
      const current = JSON.stringify(newSessionsSnapshots);
      if (current === lastSnapshot) return;

      const oldSessions = JSON.parse(lastSnapshot) as Record<string, SessionSnapshot>;
      const ts = Math.floor(Date.now() / 1000);
      for (const event of diffSessions(oldSessions, newSessionsSnapshots, ts)) {
        pushToAll(event);
      }
      lastSnapshot = current;
      pushToAll({ snapshot: newSessionsSnapshots });
    } catch (error) {
      // Callers fire this with `void` — the watcher and a timer — so a throw
      // here would surface only as an unhandled rejection. Report it on the
      // log port and keep the watcher alive for the next change.
      void log('error', 'dashboard: publishChanges failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      publishing = false;
    }
  }

  let lastMetricsMtime = 0;
  function checkMetricsChanges(): void {
    const metricsPath = join(opencodeRoot, 'metrics.jsonl');
    if (!existsSync(metricsPath)) return;
    try {
      const mtime = statSync(metricsPath).mtimeMs;
      if (mtime !== lastMetricsMtime) {
        lastMetricsMtime = mtime;
        pushToAll({ type: 'metric', ts: Math.floor(Date.now() / 1000), data: { updated: true } });
      }
    } catch {
      /* skip */
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  const stoppers: Array<() => void> = [];

  function start(): void {
    try {
      // `watch` throws on a directory that does not exist yet — no session has
      // ever been written on this machine — and that is not a reason to take
      // the dashboard down with it.
      const watcher = watch(sessionsDir, (_event, filename) => {
        if (filename && filename.endsWith('.json')) void publishChanges();
      });
      stoppers.push(() => watcher.close());
    } catch (error) {
      // Polling below covers it, but a silent fallback hides a store that is
      // not where the operator thinks — say so.
      void log('warn', 'dashboard: session watcher unavailable, polling instead', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const sessionsTimer = setInterval(() => void publishChanges(), 500);
    const metricsTimer = setInterval(checkMetricsChanges, 2000);
    stoppers.push(
      () => clearInterval(sessionsTimer),
      () => clearInterval(metricsTimer)
    );
  }

  function stop(): void {
    while (stoppers.length > 0) stoppers.pop()!();
    clients.clear();
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  const API_PATHS = [
    '/api/schema',
    '/api/session',
    '/api/dump',
    '/api/metrics',
    '/api/rag-eval',
    '/api/agents',
    '/api/beads',
    '/events',
  ];

  /**
   * The session id a path segment carries.
   *
   * The segment is percent-encoded — the id is not. Passing the raw segment
   * through meant an id needing escapes was looked up double-encoded and could
   * never be found. A segment that will not decode names no session.
   */
  function sessionId(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      return '';
    }
  }

  /**
   * The profile says which agents it has; this file keeps no list of its own.
   *
   * A literal array of ten names used to stand here. It matched
   * `profiles/android/agents` exactly — android being the only profile that
   * ships agents — so the copy could not visibly drift, and the first agent
   * another profile introduced would have been refused while its prompt sat
   * on disk.
   */
  async function agentPromptResponse(
    req: Request,
    profileId: string,
    agentId: string
  ): Promise<Response> {
    const agents = await listProfileAgents(profileId, profilesDir);
    if (!agents.includes(agentId)) {
      return json({ error: `Unknown agent ${agentId} for profile ${profileId}` }, req, 400);
    }
    const prompt = readAgentPrompt(profileId, agentId);
    if (!prompt) return json({ error: 'Prompt not found' }, req, 404);
    return json(prompt, req);
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (API_PATHS.some((p) => url.pathname.startsWith(p))) {
      const authError = checkAuth(req);
      if (authError) return authError;
    }

    if (url.pathname === '/events') {
      let controller: SSEClient;
      const stream = new ReadableStream({
        async start(c) {
          controller = c;
          clients.add(controller);
          void log('debug', 'dashboard: SSE client connected', { clients: clients.size });
          controller.enqueue(frame({ snapshot: await loadAllSessions() }));
        },
        cancel() {
          clients.delete(controller!);
          void log('debug', 'dashboard: SSE client disconnected', { clients: clients.size });
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
      const schema = await describeWorkflow({
        profileId: url.searchParams.get('profile') ?? undefined,
        schemaId: url.searchParams.get('schema') ?? undefined,
      });
      if (!schema || 'failure' in schema) {
        return json(
          {
            error:
              schema && 'failure' in schema
                ? schema.failure
                : 'No workflow to describe. Name one with ?profile=<id>&schema=<id>, or create a session.',
          },
          req,
          404
        );
      }
      return json(schema, req);
    }

    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (sessionMatch) {
      const session = await loadSession(sessionId(sessionMatch[1]!));
      if (!session) return json({ error: 'Session not found' }, req, 404);
      let stageGateResults = session.stageGateResults;
      try {
        stageGateResults = await getCurrentStageGates(session, profilesDir);
      } catch {
        // Keep serving persisted session data when its profile is unavailable.
      }
      const snapshot = toSessionSnapshot({
        ...session,
        stageGateResults,
      });
      return json(enrichSession(snapshot), req);
    }

    // HTML dashboard (same-origin, no CORS)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(dashboardHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/dump') {
      return json(await loadAllSessions(), req);
    }

    const timelineMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/timeline$/);
    if (timelineMatch) {
      const session = await loadSession(sessionId(timelineMatch[1]!));
      if (!session) return json({ error: 'Session not found' }, req, 404);
      return json(buildTimeline(toSessionSnapshot(session)), req);
    }

    const invariantsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/invariants$/);
    if (invariantsMatch) {
      const session = await loadSession(sessionId(invariantsMatch[1]!));
      if (!session) return json({ error: 'Session not found' }, req, 404);
      return json(buildInvariants(toSessionSnapshot(session)), req);
    }

    if (url.pathname === '/api/metrics') return json(readMetrics(), req);
    if (url.pathname === '/api/rag-eval') return json(readRagEval(), req);

    // `/api/agents/<profile>/<agent>/prompt` names the profile itself.
    const qualifiedPromptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/([^/]+)\/prompt$/);
    if (qualifiedPromptMatch) {
      return await agentPromptResponse(
        req,
        sessionId(qualifiedPromptMatch[1]!),
        sessionId(qualifiedPromptMatch[2]!)
      );
    }

    // `/api/agents/<agent>/prompt` does not, so the profile comes from the
    // session being worked on — the same rule `/api/schema` answers by.
    const agentPromptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
    if (agentPromptMatch) {
      const target = await newestSessionProfile();
      const profileId = target?.profileId ?? fallbackProfileId;
      if (!profileId) {
        return json(
          { error: 'No session names a profile. Ask for /api/agents/<profile>/<agent>/prompt.' },
          req,
          404
        );
      }
      return await agentPromptResponse(req, profileId, sessionId(agentPromptMatch[1]!));
    }

    const beadsIssueMatch = url.pathname.match(/^\/api\/beads\/issue\/([^/]+)$/);
    if (beadsIssueMatch) {
      return json(await getIssue(beadsIssueMatch[1]!), req);
    }

    if (url.pathname === '/api/beads/comment' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { issueId?: string; text?: string; author?: string };
        if (!body.issueId || !body.text || !body.author) {
          return json({ error: 'Missing required fields: issueId, text, author' }, req, 400);
        }
        await postComment(body.issueId, body.text, body.author);
        return json({ ok: true }, req);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, req, 500);
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  return { fetch, publishChanges, start, stop };
}
