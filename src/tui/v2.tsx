/** @jsxImportSource @opentui/solid */
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSignal, getOwner, useContext } from 'solid-js';
import type { JSX } from '@opentui/solid';
import { RendererContext } from '@opentui/solid';
import { Plugin as PluginV2, usePlugin } from '@opencode/plugin/tui';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
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
} from './v1.tsx';

const DIAG_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode');
const DIAG_LOG = join(DIAG_DIR, 'session-guard-ui.log');
const DIAG_MAX_FAILURES_PER_SLOT = 3;
const DIAG_MAX_LOG_BYTES = 2_000_000;

function diag(line: string): void {
  try {
    mkdirSync(DIAG_DIR, { recursive: true });
    if (existsSync(DIAG_LOG) && statSync(DIAG_LOG).size > DIAG_MAX_LOG_BYTES) {
      writeFileSync(DIAG_LOG, '', { mode: 0o600 });
    }
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${line}\\n`, { mode: 0o600 });
  } catch {
    // diagnostics must never crash the plugin
  }
}

try {
  diag(`module load: ${import.meta.url}`);
} catch (error) {
  diag(`module load probe failed: ${error}`);
}

const diagOkSlots = new Set<string>();
const diagFailureCount = new Map<string, number>();

function diagFailure(slot: string, error: unknown): void {
  const count = (diagFailureCount.get(slot) ?? 0) + 1;
  diagFailureCount.set(slot, count);
  if (count > DIAG_MAX_FAILURES_PER_SLOT) {
    if (count === DIAG_MAX_FAILURES_PER_SLOT + 1) {
      diag(
        `render ${slot} still failing after ${DIAG_MAX_FAILURES_PER_SLOT} logged failures; further failures are suppressed until a render succeeds`
      );
    }
    return;
  }
  const lines = [
    `render ${slot} FAILED (${count}/${DIAG_MAX_FAILURES_PER_SLOT}): ${error instanceof Error ? error.message : String(error)}`,
    `  stack: ${error instanceof Error ? error.stack : '(none)'}`,
  ];
  try {
    const owner = getOwner() as { context?: Record<string, unknown> | null } | null;
    lines.push(
      `  owner=${owner ? 'present' : 'null'}; contextKeys=[${owner ? (owner.context ? Object.keys(owner.context).join(',') : 'null') : 'none'}]`
    );
  } catch (probeError) {
    lines.push(`  owner probe failed: ${probeError}`);
  }
  try {
    lines.push(
      `  useContext(RendererContext): ${useContext(RendererContext) ? 'found' : 'MISSING'}`
    );
  } catch (probeError) {
    lines.push(`  renderer probe failed: ${probeError}`);
  }
  try {
    usePlugin();
    lines.push('  usePlugin: ok');
  } catch (probeError) {
    lines.push(`  usePlugin: FAILED ${probeError}`);
  }
  diag(lines.join('\\n'));
}

export const SessionGuardTuiV2 = (ctx: PluginV2.Context): (() => void) => {
  diag(`setup: app=${ctx.app?.version ?? '?'}; location=${ctx.location?.directory ?? '?'}`);
  const baseDir = (ctx.location ?? ctx.data.location.default())?.directory ?? process.cwd();
  const disposers: Array<() => void> = [];

  const [kvStore, setKvStore] = ctx.storage.memory('session-guard-tui-kv', {
    initial: {} as Record<string, unknown>,
  });

  const adapter = {
    slots: { register: () => '' },
    keymap: {
      registerLayer: (layer: unknown) => {
        try {
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
            ctx.ui.dialog.set({ size } as never);
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
        disposers.push(fn);
      },
    },
    event: {
      on: (event: string, handler: (event: unknown) => void) => {
        try {
          return ctx.data.on(event as never, (value: unknown) => {
            const record = (value ?? {}) as Record<string, unknown>;
            handler({ type: record.type ?? event, properties: record.properties ?? record });
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
  } as unknown as SectionApi;

  const section = createStateSection(adapter, baseDir);
  const [snapshot, setSnapshot] = createSignal<SessionGuardSnapshot>({
    view: null,
    profiles: [],
    neighbors: { previous: null, next: null, available: [] },
  });
  const coordinator = createSessionGuardCoordinator({
    section,
    api: adapter as unknown as TuiPluginApi,
    baseDir,
    onUpdate: setSnapshot,
  });
  disposers.push(() => coordinator.dispose());

  ctx.ui.slot({
    append: 'home.footer',
    render: () => (
      <HomeProfiles
        api={adapter as unknown as TuiPluginApi}
        section={section}
        snapshot={snapshot}
      />
    ),
  });

  const renderBadge = (input: { sessionID?: string }): JSX.Element | null => {
    const slot = 'prompt.footer.status';
    try {
      const sessionID = input?.sessionID;
      if (typeof sessionID !== 'string' || sessionID === '') return null;
      const root = ctx.data.session.root(sessionID) || sessionID;
      const stage = readActiveStage(baseDir, root);
      if (stage === null) return null;
      const theme = ctx.theme as unknown as Record<string, unknown>;
      const color =
        (theme as { text?: { feedback?: { success?: { base?: string } }; success?: string } })?.text
          ?.feedback?.success?.base ??
        (theme as { text?: { success?: string } })?.text?.success ??
        '#ccc';
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
              api={adapter as unknown as TuiPluginApi}
              section={section}
              sessionId={input?.sessionID ?? ''}
              snapshot={snapshot}
              coordinator={coordinator}
            />
            <RulesSidebarContent
              sessionId={input?.sessionID ?? ''}
              api={adapter as unknown as TuiPluginApi}
              theme={(adapter as unknown as { theme: TuiPluginApi['theme'] }).theme}
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

  return () => {
    disposers.splice(0).forEach((dispose) => {
      try {
        dispose();
      } catch {
        /* ignore disposal errors */
      }
    });
  };
};

export { PluginV2 };
