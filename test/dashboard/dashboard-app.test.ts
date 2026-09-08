import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDashboard, type Dashboard } from '../../src/dashboard/dashboard-app.ts';
import { sessionFileName } from '../../src/session/session-files.ts';
import { createSession } from '../../src/session/session-store.ts';
import { WorkflowSessionSchema } from '../../src/session/session-schema.ts';

/**
 * The dashboard, exercised through its own handlers.
 *
 * Everything here used to be a string match against `dashboard-server.ts`,
 * because that module started a server, a watcher and two timers at import
 * time and read its directories into constants before a test could say
 * otherwise. Those assertions broke three times on comments that merely
 * mentioned the wrong word — they were reading prose, not behaviour.
 */

const ROOT = path.join('/tmp', 'dashboard-app-test-' + randomUUID());
const SESSIONS = path.join(ROOT, 'sessions');
const OPENCODE = path.join(ROOT, '.opencode');
const AGENTS = path.join(ROOT, 'agents');
// The sync writes one flat directory, with the profile in the file name.
const ANDROID_AGENTS = AGENTS;
const PROFILES = path.join(ROOT, 'profiles');
const PROFILE_AGENTS = path.join(PROFILES, 'android', 'agents');

let dashboard: Dashboard;

function make(overrides: Partial<Parameters<typeof createDashboard>[0]> = {}): Dashboard {
  return createDashboard({
    sessionsDir: SESSIONS,
    profilesDir: PROFILES,
    opencodeRoot: OPENCODE,
    agentsDir: AGENTS,
    ...overrides,
  });
}

async function writeSession(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const session = {
    ...WorkflowSessionSchema.parse(createSession(id, 'android', 'state-machine')),
    ...overrides,
  };
  await writeFile(path.join(SESSIONS, sessionFileName(id)), JSON.stringify(session));
}

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://dashboard.test${url}`, { headers });
}

describe('dashboard', () => {
  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(SESSIONS, { recursive: true });
    await mkdir(ANDROID_AGENTS, { recursive: true });
    await mkdir(PROFILE_AGENTS, { recursive: true });
    // The profile is what says an agent exists; the harness directory only
    // holds the copies the sync made.
    await writeFile(path.join(PROFILE_AGENTS, 'code.md'), '# code');
    dashboard = make();
  });

  afterEach(async () => {
    dashboard.stop();
    await rm(ROOT, { recursive: true, force: true });
  });

  describe('GET /api/dump', () => {
    it('answers with every session the store holds', async () => {
      await writeSession('ses-1');
      await writeSession('ses-2');

      const body = (await (await dashboard.fetch(get('/api/dump'))).json()) as Record<
        string,
        { sessionId: string }
      >;

      expect(Object.keys(body).sort()).toEqual(['ses-1', 'ses-2']);
      expect(body['ses-1']?.sessionId).toBe('ses-1');
    });

    it('is not stopped by a file whose name is not a session id', async () => {
      await writeSession('ses-1');
      // `%ZZ` is not a valid escape sequence: decoding it threw URIError out of
      // the listing loop, and every session went missing at once.
      await writeFile(path.join(SESSIONS, '%ZZ.json'), '{}');

      const body = (await (await dashboard.fetch(get('/api/dump'))).json()) as Record<
        string,
        unknown
      >;

      expect(Object.keys(body)).toEqual(['ses-1']);
    });

    it('leaves out a session whose file is corrupt rather than answering with an old copy', async () => {
      await writeSession('healthy');
      await dashboard.fetch(get('/api/dump')); // the dashboard has now seen it
      await writeFile(path.join(SESSIONS, sessionFileName('healthy')), '{ not json');

      const body = (await (await dashboard.fetch(get('/api/dump'))).json()) as Record<
        string,
        unknown
      >;

      expect(body).toEqual({});
    });
  });

  describe('GET /api/session/:id', () => {
    it('reports the stage the engine derived', async () => {
      await writeSession('ses-1', { currentStage: 'code' });

      const body = (await (await dashboard.fetch(get('/api/session/ses-1'))).json()) as {
        stage: string;
      };

      expect(body.stage).toBe('code');
    });

    it('reads an id that needs escaping in its file name', async () => {
      await writeSession('ses/1');

      const response = await dashboard.fetch(get(`/api/session/${encodeURIComponent('ses/1')}`));

      expect(response.status).toBe(200);
    });

    it('answers 404 for a session the store does not hold', async () => {
      const response = await dashboard.fetch(get('/api/session/absent'));

      expect(response.status).toBe(404);
    });
  });

  describe('authorisation', () => {
    it('lets every API request through when no token is configured', async () => {
      expect((await dashboard.fetch(get('/api/dump'))).status).toBe(200);
    });

    it('refuses an API request without the configured token', async () => {
      const guarded = make({ token: 'secret' });

      expect((await guarded.fetch(get('/api/dump'))).status).toBe(401);
      expect(
        (await guarded.fetch(get('/api/dump', { Authorization: 'Bearer wrong' }))).status
      ).toBe(403);
      expect(
        (await guarded.fetch(get('/api/dump', { Authorization: 'Bearer secret' }))).status
      ).toBe(200);
      guarded.stop();
    });

    it('serves the page itself without a token', async () => {
      const guarded = make({ token: 'secret' });

      expect((await guarded.fetch(get('/'))).status).toBe(200);
      guarded.stop();
    });
  });

  describe('CORS', () => {
    it('answers the configured origin and no other', async () => {
      const shared = make({ allowedOrigin: 'https://ops.example' });

      const allowed = await shared.fetch(get('/api/dump', { Origin: 'https://ops.example' }));
      const other = await shared.fetch(get('/api/dump', { Origin: 'https://elsewhere.example' }));

      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://ops.example');
      expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
      shared.stop();
    });
  });

  describe('agent prompts', () => {
    // The sync writes `<harness>/agents/<profileId>/<agent>.md`. This endpoint
    // used to read a flat `<repo>/agent/<agent>.md`, a directory this project
    // does not have, so it answered 404 for every agent that has ever existed.
    it('reads a prompt named by profile and agent', async () => {
      await writeFile(path.join(ANDROID_AGENTS, 'android_code.md'), '# code');

      const body = (await (
        await dashboard.fetch(get('/api/agents/android/code/prompt'))
      ).json()) as { content: string };

      expect(body.content).toBe('# code');
    });

    it('takes the profile from the session being worked on when the url omits it', async () => {
      await writeFile(path.join(ANDROID_AGENTS, 'android_code.md'), '# code');
      await writeSession('ses-1'); // createSession writes profileId android

      const body = (await (await dashboard.fetch(get('/api/agents/code/prompt'))).json()) as {
        content: string;
      };

      expect(body.content).toBe('# code');
    });

    it('says so when no session names a profile and the url does not either', async () => {
      await writeFile(path.join(ANDROID_AGENTS, 'android_code.md'), '# code');

      const response = await dashboard.fetch(get('/api/agents/code/prompt'));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toContain('No session');
    });

    it('refuses an agent the profile does not ship', async () => {
      const response = await dashboard.fetch(get('/api/agents/android/intruder/prompt'));

      expect(response.status).toBe(400);
    });

    it('serves an agent the profile ships but no literal list ever named', async () => {
      // The roster used to be ten names written into the dashboard. It matched
      // android exactly, so it could not visibly drift — and the first agent
      // any other profile introduced would have been refused.
      await writeFile(path.join(PROFILE_AGENTS, 'kotlin-reviewer.md'), '# reviewer');
      await writeFile(path.join(ANDROID_AGENTS, 'android_kotlin-reviewer.md'), '# reviewer');

      const body = (await (
        await dashboard.fetch(get('/api/agents/android/kotlin-reviewer/prompt'))
      ).json()) as { content: string };

      expect(body.content).toBe('# reviewer');
    });

    it('separates an agent the profile ships from one whose prompt is not synced', async () => {
      await writeFile(path.join(PROFILE_AGENTS, 'not-synced.md'), '# pending');

      const response = await dashboard.fetch(get('/api/agents/android/not-synced/prompt'));

      expect(response.status).toBe(404);
    });

    it('serves nothing for a segment that climbs out of the directory', async () => {
      await writeFile(path.join(ROOT, 'code.md'), '# elsewhere');

      // The roster refuses it first — no profile up there ships anything — and
      // the `resolve` guard in the reader stands behind that.
      const climbingProfile = await dashboard.fetch(get('/api/agents/..%2F..%2Fetc/code/prompt'));
      const climbingAgent = await dashboard.fetch(get('/api/agents/android/..%2F..%2Fcode/prompt'));

      for (const response of [climbingProfile, climbingAgent]) {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.json()).not.toHaveProperty('content');
      }
    });
  });

  describe('GET /events', () => {
    it('opens with a snapshot of the store', async () => {
      await writeSession('ses-1');

      const response = await dashboard.fetch(get('/events'));
      const first = await response.body!.getReader().read();
      const message = new TextDecoder().decode(first.value);

      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(JSON.parse(message.replace(/^data: /, '').trim())).toEqual({
        snapshot: { 'ses-1': expect.objectContaining({ sessionId: 'ses-1' }) },
      });
    });

    it('pushes a stage change as an event and a fresh snapshot', async () => {
      await writeSession('ses-1', { currentStage: 'planning' });
      const response = await dashboard.fetch(get('/events'));
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const messages: Array<Record<string, unknown>> = [];
      async function drain(count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
          const chunk = await reader.read();
          if (chunk.done) return;
          messages.push(
            JSON.parse(
              decoder
                .decode(chunk.value)
                .replace(/^data: /, '')
                .trim()
            ) as Record<string, unknown>
          );
        }
      }

      await drain(1); // the opening snapshot
      await dashboard.publishChanges(); // the dashboard now knows the planning state
      await drain(1);

      await writeSession('ses-1', { currentStage: 'code' });
      await dashboard.publishChanges();
      await drain(2);

      // The event feeds the timeline; the snapshot is what actually updates the
      // page. The client used to be sent only events, and keyed them on a field
      // the server never sent, so nothing on the page ever moved.
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'transition',
          sessionId: 'ses-1',
          from: 'planning',
          to: 'code',
        })
      );
      const last = messages[messages.length - 1] as {
        snapshot?: Record<string, { currentStage: string }>;
      };
      expect(last.snapshot?.['ses-1']?.currentStage).toBe('code');
    });
  });
});
