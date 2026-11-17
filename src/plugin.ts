import type { PluginModule as PluginV1 } from '@opencode-ai/plugin';
import type { Plugin as PluginV2 } from '@opencode/plugin/promise/plugin';
import pkg from '../package.json' with { type: 'json' };
const { default: SessionGuardPluginV1 } = await import('./v1/plugin.js');
const { default: SessionGuardPluginV2 } = await import('./v2/plugin.js');

// Contract for profile authors: the shape of an entry in a profile's
// `INVARIANTS` array. Re-exported from the root entrypoint (./plugin) so a
// profile outside this repository can import the type from the package root.
export type { InvariantCheck } from './types/index.ts';

const id = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : 'session-guard';

export default {
  ...SessionGuardPluginV2,
  id,
  server: SessionGuardPluginV1,
} satisfies PluginV1 & PluginV2;
