import { type Hooks, type Plugin as PluginV1, type PluginInput } from '@opencode-ai/plugin';
import { mkdirSync, writeFileSync } from 'node:fs';
import { opencodeStateDir, profilesDir, sessionsDir } from './app/paths.ts';
import { createRuntime as createRulesRuntime } from './rules-engine/runtime/create-runtime.js';
import { wireV1Rules } from './rules-engine/runtime/v1-adapter.js';
import {
  parsePluginOptions,
  resolveAdditionalRuleDirectories,
} from './rules-engine/config/plugin-options.js';

// Contract for profile authors: the shape of an entry in a profile's
// `INVARIANTS` array. It is re-exported here because the package publishes
// only this entrypoint - `src/types/index.ts` is not an exported subpath, so a
// profile outside this repository had no public path to the type and had to
// name a non-existent one.
export type { InvariantCheck } from './types/index.ts';

export const SessionGuardPluginV1: PluginV1 = async (ctx: PluginInput): Promise<Hooks> => {
  console.error('[session-guard] plugin v1');

  const projectDir = ctx.directory;
  const baseDir = opencodeStateDir();

  const profiles = profilesDir(projectDir);

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
    const hooks = createRuntime(ctx, { storeDir: runtime, profilesDir: profiles });
    const pluginOptions = ctx as PluginInput & { options?: unknown };
    const { additionalRuleDirectories } = parsePluginOptions(
      pluginOptions.options as Readonly<Record<string, unknown>> | undefined
    );
    const rulesRuntime = await createRulesRuntime({
      client: ctx.client,
      directory: ctx.worktree || ctx.directory,
      projectDirectory: ctx.directory,
      additionalRuleDirectories: resolveAdditionalRuleDirectories(
        additionalRuleDirectories,
        ctx.directory
      ),
    });
    const rulesCleanup = await wireV1Rules(rulesRuntime, hooks);
    const runtimeDispose = hooks.dispose;
    hooks.dispose = async () => {
      try {
        await rulesCleanup();
      } finally {
        await runtimeDispose?.();
      }
    };
    return hooks;
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
