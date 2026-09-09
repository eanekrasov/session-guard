import { type Hooks, type Plugin as PluginV1, type PluginInput } from '@opencode-ai/plugin';
import { Plugin } from '@opencode/plugin';
import { mkdirSync, writeFileSync } from 'node:fs';
import { opencodeStateDir, profilesDir, sessionsDir } from './app/paths.ts';
import type { Cleanup, Context } from '@opencode/plugin/promise/plugin';

export const SessionGuardPluginV1: PluginV1 = async (ctx: PluginInput): Promise<Hooks> => {
  console.error('[session-guard] plugin v1');

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
    console.error('[session-guard] init error:', process.env.OPENCODE_HARNESS_DIR);
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

export const SessionGuardPluginV2 = async (ctx: Context): Promise<Cleanup> => {
  await ctx.tool.hook('execute.before', () => {
    console.error('A tool is about to run');
  });

  return () => {
    console.error('unloaded');
  };
};

export default {
  ...Plugin.define({
    id: 'session-guard',
    async setup(ctx: Context): Promise<Cleanup | void> {
      return await SessionGuardPluginV2(ctx);
    },
  }),
  async server(ctx: PluginInput): Promise<Hooks> {
    return await SessionGuardPluginV1(ctx);
  },
};
