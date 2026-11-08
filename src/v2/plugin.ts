import type { Cleanup, Context, Plugin } from '@opencode/plugin/promise/plugin';
import { setupV2Runtime } from '../app/v2-plugin-adapter.ts';

const SessionGuardPluginV2: Plugin = {
  id: 'session-guard',
  async setup(ctx: Context): Promise<Cleanup> {
    return setupV2Runtime(ctx);
  },
};

export default SessionGuardPluginV2;
