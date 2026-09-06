import { type Plugin, type PluginInput } from '@opencode-ai/plugin';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harnessDir, opencodeStateDir, profilesDir, sessionsDir } from './app/paths.ts';

export const StateMachinePlugin: Plugin = async (ctx: PluginInput) => {
  console.error('[state-machine] StateMachinePlugin');

  const projectDir = ctx.directory;
  const baseDir = opencodeStateDir();

  // Создаём директории (try-catch для поддержки read-only env в тестах)
  const profiles = profilesDir(projectDir);
  try {
    mkdirSync(profiles, { recursive: true });
  } catch {
    /* не критично */
  }

  const runtime = sessionsDir(baseDir);
  try {
    mkdirSync(runtime, { recursive: true });
  } catch {
    /* не критично */
  }

  // The computed defaults are handed to this instance, never written into
  // process.env. Writing them turned the first project's local default into a
  // global override, and a second plugin instance for another project was
  // served the first project's profiles and sessions.
  try {
    const { createRuntime } = await import('./app/runtime.ts');
    return createRuntime(ctx, { storeDir: runtime, profilesDir: profiles });
  } catch (e) {
    console.error('[state-machine] init error:', process.env.OPENCODE_HARNESS_DIR);
    writeFileSync(
      `${runtime}/sm-init-error.json`,
      JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.slice(0, 500) : '',
        ts: new Date().toISOString(),
      })
    );
    return {};
  }
};

const plugin = {
  id: 'state-machine',
  server: StateMachinePlugin,
};

export default plugin;
