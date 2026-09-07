import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The dashboard must read the store the plugin writes.
 *
 * `SESSIONS_DIR` was hardcoded to `<repo>/.opencode/state-machine/sessions`,
 * a path nothing has written since the store moved out of the project, so the
 * dashboard listed an empty directory while the plugin was running. This is a
 * source assertion rather than a behavioural one because the module starts a
 * server at import time.
 */
describe('the dashboard reads the plugin store', () => {
  const source = readFileSync(
    join(import.meta.dirname, '../../src/dashboard/dashboard-server.ts'),
    'utf-8'
  );

  it('derives SESSIONS_DIR from the shared path rule', () => {
    expect(source).toContain('const SESSIONS_DIR = sessionsDir(opencodeStateDir());');
  });

  it('does not reach back into the project directory for sessions', () => {
    expect(source).not.toContain("'.opencode', 'state-machine', 'sessions'");
  });

  it('keeps no copy of a workflow in the server file', () => {
    // Two hardcoded copies of the base workflow lived here: DEFAULT_ENGINE_CONFIG,
    // which `stageOf` measured every session of every profile against, and a
    // second, different list of stages and edges answering /api/schema. They
    // disagreed with each other — one had a `validation` stage, the other did
    // not — and both had drifted from profiles/base/base.yaml. Neither failed
    // when it drifted, because nothing compared them to anything.
    expect(source).not.toContain('DEFAULT_ENGINE_CONFIG');
    expect(source).not.toContain("{ from: 'planning', to: 'tasks_ready' }");
    expect(source).not.toContain('BASE_WORKFLOW_GATES');
  });

  it('reads sessions through the shared reader rather than the directory', () => {
    // The server used to list the directory itself. It stripped the extension
    // by first match — the file `a.jsonb.json` reported the session `ab.json` —
    // and decoded outside its own try, so one undecodable name threw URIError
    // and hid every session. Both rules live in session-files now, which has
    // its own behavioural tests; what this file can still check is that the
    // server does not keep a second copy of them.
    expect(source).toContain('readAllSessions, readSession');
    expect(source).not.toContain('readdirSync');
    expect(source).not.toContain('decodeURIComponent');
  });

  it('does not answer a broken session with a stale copy of itself', () => {
    // `prevSessions` recorded only the first snapshot it ever saw and never
    // updated it, so a corrupt file was answered with the session as it looked
    // when the dashboard started.
    expect(source).not.toContain('prevSessions');
  });

  it('reads the stage the engine already derived, and compiles a real profile', () => {
    expect(source).toContain("const stage = session['currentStage'];");
    expect(source).toContain('compileWorkflow(');
    expect(source).toContain('resolveConfig(target.profileId, PROFILES_DIR)');
  });

  it('uses the same rule as the plugin runtime', async () => {
    const { sessionsDir, opencodeStateDir } = await import('../../src/app/paths.ts');
    const previous = process.env.STATE_MACHINE_STORE_DIR;
    try {
      process.env.STATE_MACHINE_STORE_DIR = '/tmp/an-operator-override';
      expect(sessionsDir(opencodeStateDir())).toBe('/tmp/an-operator-override');
    } finally {
      if (previous === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
      else process.env.STATE_MACHINE_STORE_DIR = previous;
    }
  });
});
