import { define, type Context } from '@opencode/plugin/tui/plugin';
import { SessionGuardTuiV2 } from './tui/v2.tsx';

export default define({
  id: 'session-guard-tui',
  setup(ctx: Context) {
    // return ctx.client.rpc(MemToast).events.on('toast', (event) => {ctx.ui.toast.show(event.data as MemToastPayload);});
    return SessionGuardTuiV2(ctx);
  },
});
