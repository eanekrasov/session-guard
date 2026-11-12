/** @jsxImportSource @opentui/solid */
import { createSignal } from 'solid-js';
import type { JSX } from '@opentui/solid';
import { Plugin as PluginV2 } from '@opencode/plugin/tui';
import {
  createStateSection,
  createSessionGuardCoordinator,
  WorkflowSidebarContent,
  HomeProfiles,
  RulesSidebarContent,
  readActiveStage,
  DETAILS_TITLE,
  type SectionApi,
  type SessionGuardSnapshot,
  type TuiThemeApi,
} from './v1.tsx';
import { createDisposables } from './setup.ts';
import { diag, diagFailure, diagFailureCount, diagOkSlots } from './diag.ts';

export const SessionGuardTuiV2 = (ctx: PluginV2.Context): (() => void) => {
  diag(`setup: app=${ctx.app?.version ?? '?'}; location=${ctx.location?.directory ?? '?'}`);
  const baseDir = (ctx.location ?? ctx.data.location.default())?.directory ?? process.cwd();
  const bag = createDisposables();

  const [kvStore, setKvStore] = ctx.storage.memory('session-guard-tui-kv', {
    initial: {} as Record<string, unknown>,
  });

  const adapter = {
    slots: { register: () => '' },
    keymap: {
      registerLayer: (layer: unknown) => {
        try {
          // V1's OpenTUI layer shape differs from V2's keymap layer contract.
          ctx.keymap.layer(() => layer as never);
        } catch {
          /* keep the widget usable if keymap registration is unavailable */
        }
        return undefined;
      },
    },
    ui: {
      DialogAlert: (props: { title: string; message: string; onConfirm?: () => void }) => (
        <box flexDirection="column" border borderColor="#888" padding={1}>
          <text>{props.title}</text>
          <text>{props.message}</text>
          <text onMouseUp={props.onConfirm}>OK</text>
        </box>
      ),
      dialog: {
        setSize: (size: 'medium' | 'large' | 'xlarge') => {
          try {
            ctx.ui.dialog.set({ size });
          } catch {
            /* ignore host differences */
          }
        },
        replace: (render: () => JSX.Element, onClose?: () => void) => {
          try {
            ctx.ui.dialog.show(render, onClose);
          } catch {
            /* ignore host differences */
          }
        },
        clear: () => {
          try {
            ctx.ui.dialog.clear();
          } catch {
            /* ignore host differences */
          }
        },
      },
    },
    kv: {
      get: <Value = unknown,>(key: string, fallback?: Value): Value => {
        const value = (kvStore as Record<string, unknown>)[key];
        return (value === undefined ? fallback : value) as Value;
      },
      set: (key: string, value: unknown) => {
        setKvStore((draft: Record<string, unknown>) => {
          draft[key] = value;
        });
      },
    },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          try {
            await ctx.data.session.sync(sessionID);
          } catch {
            /* ignore sync failures and fall back to cached data */
          }
          const info = ctx.data.session.get(sessionID);
          return { data: info ? { id: info.id, parentID: info.parentID } : { id: sessionID } };
        },
      },
    },
    lifecycle: {
      onDispose: (fn: () => void) => {
        bag.add(fn);
      },
    },
    event: {
      on: (event: string, handler: (event: unknown) => void) => {
        try {
          return ctx.data.on(event as never, (value: unknown) => {
            const record =
              typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
            const properties =
              typeof record.properties === 'object' && record.properties !== null
                ? (record.properties as Record<string, unknown>)
                : record;
            handler({
              type: typeof record.type === 'string' ? record.type : event,
              properties,
            });
          });
        } catch {
          return () => {};
        }
      },
    },
    renderer: { requestRender: () => {} },
    theme: {
      current: {
        text: ctx.theme.text.base,
        textMuted: ctx.theme.text.muted,
        primary: ctx.theme.text.action.primary.base,
        secondary: ctx.theme.text.muted,
        accent: ctx.theme.text.action.primary.base,
        success: ctx.theme.text.feedback.success.base,
        warning: ctx.theme.text.feedback.warning.base,
        error: ctx.theme.text.feedback.error.base,
        info: ctx.theme.text.feedback.info.base,
        border: ctx.theme.border.base,
      },
    },
  } satisfies SectionApi & TuiThemeApi;

  const section = createStateSection(adapter, baseDir);
  const [snapshot, setSnapshot] = createSignal<SessionGuardSnapshot>({
    view: null,
    profiles: [],
    neighbors: { previous: null, next: null, available: [] },
  });
  const coordinator = createSessionGuardCoordinator({
    section,
    api: adapter,
    baseDir,
    onUpdate: setSnapshot,
  });
  bag.add(() => coordinator.dispose());

  ctx.ui.slot({
    append: 'home.footer',
    render: () => <HomeProfiles api={adapter} section={section} snapshot={snapshot} />,
  });

  const renderBadge = (input: { sessionID?: string }): JSX.Element | null => {
    const slot = 'prompt.footer.status';
    try {
      const sessionID = input?.sessionID;
      if (typeof sessionID !== 'string' || sessionID === '') return null;
      const root = ctx.data.session.root(sessionID) || sessionID;
      const stage = readActiveStage(baseDir, root);
      if (stage === null) return null;
      const color = ctx.theme.text.feedback.success.base;
      if (!diagOkSlots.has(slot)) {
        diagOkSlots.add(slot);
        diagFailureCount.delete(slot);
        diag(`render ${slot} ok`);
      }
      return <text fg={color}>{`🛡️ ${stage}`}</text>;
    } catch (err) {
      console.error('[tui] v2 badge render error:', err);
      diagOkSlots.delete(slot);
      diagFailure(slot, err);
      return null;
    }
  };

  ctx.ui.slot({ append: 'prompt.footer.status', render: renderBadge });

  const sidebarSlot = 'sidebar.content';
  ctx.ui.slot({
    append: 'sidebar.content',
    render: (input: { sessionID?: string }) => {
      try {
        const result = (
          <box flexDirection="column">
            <WorkflowSidebarContent
              api={adapter}
              section={section}
              sessionId={input?.sessionID ?? ''}
              snapshot={snapshot}
              coordinator={coordinator}
            />
            <RulesSidebarContent
              sessionId={input?.sessionID ?? ''}
              projectDir={baseDir}
              event={{
                on: (event, handler) =>
                  adapter.event.on(event, (value) => {
                    const record =
                      typeof value === 'object' && value !== null
                        ? (value as Record<string, unknown>)
                        : {};
                    const properties =
                      typeof record.properties === 'object' && record.properties !== null
                        ? (record.properties as Record<string, unknown>)
                        : record;
                    handler({
                      type: typeof record.type === 'string' ? record.type : event,
                      properties,
                    });
                  }),
              }}
              theme={adapter.theme}
            />
          </box>
        );
        if (!diagOkSlots.has(sidebarSlot)) {
          diagOkSlots.add(sidebarSlot);
          diagFailureCount.delete(sidebarSlot);
          diag(`render ${sidebarSlot} ok`);
        }
        return result;
      } catch (err) {
        console.error('[tui] v2 sidebar render error:', err);
        diagOkSlots.delete(sidebarSlot);
        diagFailure(sidebarSlot, err);
        return <text>⚠️ {String(err)}</text>;
      }
    },
  });

  let keymapRegistered = false;
  ctx.ui.slot({
    append: 'app',
    render: () => {
      if (!keymapRegistered) {
        keymapRegistered = true;
        try {
          ctx.keymap.layer(() => ({
            commands: [
              {
                id: 'session-guard.workflow.details',
                title: DETAILS_TITLE,
                description: 'Show full workflow state',
                group: 'Session Guard',
                palette: true,
                slash: { name: 'session-guard-details' },
                run: () => section.openDetails(null),
              },
              {
                id: 'session-guard.toggle-sidebar',
                title: 'Toggle sidebar section',
                group: 'Session Guard',
                palette: true,
                slash: { name: 'session-guard-toggle' },
                run: () => section.toggleVisibility(),
              },
            ],
            bindings: [],
          }));
        } catch {
          /* keep the widget usable if keymap registration is unavailable */
        }
      }
      return null;
    },
  });

  return () => bag.dispose();
};

export { PluginV2 };
