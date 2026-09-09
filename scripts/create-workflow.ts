/**
 * Создаёт workflow через вызов handleCreateWorkflow напрямую.
 * Запуск: bun run scripts/create-workflow.ts [sessionID]
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

async function main() {
  const sessionID = process.argv[2] ?? 'dev-session';
  const profilesDir = resolve(import.meta.dir!, '../test/fixtures/profiles');

  // Пишем туда же, куда смотрит TUI
  const runtimeDir = resolve(import.meta.dir!, '..', '.opencode', 'session-guard', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });

  process.env.SESSION_GUARD_STORE_DIR = runtimeDir;
  process.env.SESSION_GUARD_PROFILES_DIR = profilesDir;

  const { createRuntime } = await import('../src/app/runtime.ts');

  const hooks = createRuntime({
    client: {} as never,
    project: {
      id: 'session-guard',
      name: 'session-guard',
      directory: resolve(import.meta.dir!, '..'),
      worktree: resolve(import.meta.dir!, '..'),
      time: { created: Date.now() },
    } as never,
    directory: resolve(import.meta.dir!, '..'),
    worktree: resolve(import.meta.dir!, '..'),
    experimental_workspace: {} as never,
    serverUrl: new URL('http://localhost:0'),
    $: {} as never,
  });

  const result = await hooks.tool!['workflow-create'].execute(
    { schemaId: 'android' },
    {
      sessionID,
      messageID: 'msg-1',
      agent: 'script',
      directory: resolve(import.meta.dir!, '..'),
      worktree: resolve(import.meta.dir!, '..'),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
  );

  console.log(typeof result === 'string' ? result : result.output);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
