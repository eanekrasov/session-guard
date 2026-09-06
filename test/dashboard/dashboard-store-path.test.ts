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
