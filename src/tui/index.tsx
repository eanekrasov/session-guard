export {
  createStateSection,
  createSessionGuardCoordinator,
  __sectionForTests,
  formatBadge,
  runtimeDirs,
  readActiveStage,
  WorkflowSidebarContent,
  DETAILS_TITLE,
} from './v1.tsx';
export type { SectionApi, SessionGuardSnapshot } from './v1.tsx';
export { SessionGuardTuiV2 } from './v2.tsx';

import { Plugin as PluginV2 } from '@opencode/plugin/tui';
import v1 from './v1.tsx';
import { SessionGuardTuiV2 } from './v2.tsx';

const id = v1.id ?? 'session-guard.sidebar-state';

export default {
  ...PluginV2.define({
    id,
    setup: async (ctx) => SessionGuardTuiV2(ctx),
  }),
  tui: v1.tui,
};
