import { describe, expect, it } from 'vitest';

/**
 * The dashboard must read the store the plugin writes.
 *
 * `SESSIONS_DIR` was hardcoded to `<repo>/.opencode/session-guard/sessions`, a
 * path nothing has written since the store moved out of the project, so the
 * dashboard listed an empty directory while the plugin was running.
 *
 * This file used to assert against the text of `dashboard-server.ts`, because
 * that module started a server at import time and could not be exercised. It
 * can now: the behaviour lives in `dashboard-app.ts` and is covered by
 * `dashboard-app.test.ts`. What is left here is the one thing that is genuinely
 * about the entry point — that it resolves the store by the shared rule rather
 * than inventing a path of its own.
 */
describe('the dashboard reads the plugin store', () => {
  it('resolves the store by the same rule as the plugin runtime', async () => {
    const { sessionsDir, opencodeStateDir } = await import('../../src/app/paths.ts');
    const previous = process.env.SESSION_GUARD_STORE_DIR;
    try {
      process.env.SESSION_GUARD_STORE_DIR = '/tmp/an-operator-override';
      expect(sessionsDir(opencodeStateDir())).toBe('/tmp/an-operator-override');
    } finally {
      if (previous === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
      else process.env.SESSION_GUARD_STORE_DIR = previous;
    }
  });

  it('hands the entry point no store path of its own', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../src/dashboard/dashboard-server.ts', import.meta.url),
      'utf-8'
    );
    expect(source).toContain('sessionsDir(opencodeStateDir())');
    expect(source).not.toContain("'.opencode', 'session-guard', 'sessions'");
  });
});
