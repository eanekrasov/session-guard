// Гибридный TUI-плагин: default = `{ id, setup, tui }`.
// - v2-рантайм (opencode 2.x) вызывает `setup(ctx)`.
// - v1-рантайм (opencode 1.x, plugin/tui) вызывает `tui(api, options, meta)`.
//
// Структура src зеркалит plugin-экспорты: v1-код живёт в `src/tui/v1.tsx`,
// v2 — в `src/tui/v2.tsx`, а этот файл — гибрид-точка входа (`./tui`).
import { Plugin as PluginV2 } from '@opencode/plugin/tui';
import v1 from './tui/v1.tsx';
import { SessionGuardTuiV2 } from './tui/v2.tsx';

export {
  createStateSection,
  createSessionGuardCoordinator,
  __sectionForTests,
  formatBadge,
  runtimeDirs,
  readActiveStage,
  WorkflowSidebarContent,
  DETAILS_TITLE,
} from './tui/v1.tsx';
export type { SectionApi, SessionGuardSnapshot } from './tui/v1.tsx';
export { SessionGuardTuiV2 } from './tui/v2.tsx';

export default {
  ...PluginV2.define({
    id: v1.id,
    setup: async (ctx) => SessionGuardTuiV2(ctx),
  }),
  tui: v1.tui,
};
