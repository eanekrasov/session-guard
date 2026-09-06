/** @jsxImportSource @opentui/solid */
// TUI-плагин: секция текущего state workflow в sidebar OpenCode.
// Контракты: specs/002-sidebar-state-display/contracts/tui-plugin.md,
// contracts/runtime-state-read.md. Read-only по отношению к runtime-состоянию.
import { existsSync, readFileSync, watch as watchFs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import type { KeyEvent } from '@opentui/core';
import type { JSX } from '@opentui/solid';
import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { listProfiles, resolveConfig } from '../public-api.ts';
import { opencodeStateDir, profilesDir as resolveProfilesDir, sessionsDir } from '../app/paths.ts';
import { checkTransition } from '../domain/engine.ts';
import { toSessionFacts } from '../domain/session-facts.ts';
import type { ResolvedSchema } from '../schema/types.ts';
import type { ProfileMetadata } from '../schema/types.ts';
import { WorkflowSessionSchema } from '../session/session-schema.ts';
import { formatDetailsLines, isRecord, parseRuntimeState, type Tui } from './tui.ts';
import { buildPanelPalette, createPanelLayout, TuiPanel, TuiSection } from './tui-panel/index.ts';
import { SidebarContent as RulesSidebarContent } from './slots/sidebar-content.tsx';

const id = 'session-guard.sidebar-state' as const;
const SLOT_ORDER = 350;

const DETAILS_COMMAND = 'harness.workflow.details';
const DETAILS_TITLE = 'Workflow: full state';
const TOGGLE_COMMAND = 'harness.toggle_sidebar';
const KV_SIDEBAR_ENABLED = 'state-machine.sidebar.enabled.v4';
const KV_SECTION_OPEN = 'state-machine.sidebar.section_open';

/** Строка-заглушка, когда нет активного FSM-состояния. */
type SessionLike = { id?: string; parentID?: string };

function profileDirs(baseDir: string): string[] {
  // The server plugin resolves profiles from PluginInput.directory. The TUI
  // must use the same OpenCode project directory and never fall back to the
  // plugin bundle or the TUI process cwd.
  return [resolveProfilesDir(baseDir)];
}

function readRuntimeFile(sessionId: string, baseDir: string): string | null {
  // Сначала STATE_MACHINE_STORE_DIR (основной канал), потом baseDir/sessions, потом opencodeStateDir/sessions
  const candidates: string[] = [];
  const env = process.env.STATE_MACHINE_STORE_DIR;
  if (env) candidates.push(env);
  candidates.push(sessionsDir(baseDir));
  candidates.push(sessionsDir(opencodeStateDir()));
  // Accept the store root as well as the current runtime/ subdirectory. This
  // keeps the reader compatible with older installations that stored session
  // files directly under ~/.local/share/opencode/session-guard/.
  candidates.push(join(opencodeStateDir(), 'session-guard'));
  // Уникализируем
  const seen = new Set<string>();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      const names = [`${encodeURIComponent(sessionId)}.json`, `${sessionId}.json`];
      for (const name of names) {
        const path = join(dir, name);
        if (existsSync(path)) return readFileSync(path, 'utf8');
      }
    } catch {
      continue;
    }
  }
  return null;
}

function runtimeDirs(baseDir: string): string[] {
  return [
    process.env.STATE_MACHINE_STORE_DIR,
    sessionsDir(baseDir),
    sessionsDir(opencodeStateDir()),
    join(opencodeStateDir(), 'session-guard'),
  ].filter((dir): dir is string => Boolean(dir));
}

export type SectionApi = {
  slots: {
    register: (config: never) => unknown;
  };
  keymap: {
    registerLayer: (layer: never) => unknown;
  };
  ui: {
    DialogAlert: (props: { title: string; message: string; onConfirm?: () => void }) => JSX.Element;
    dialog: {
      setSize: (size: 'medium' | 'large' | 'xlarge') => void;
      replace: (render: () => JSX.Element, onClose?: () => void) => void;
      clear: () => void;
    };
  };
  kv: {
    get: <Value = unknown>(key: string, fallback?: Value) => Value;
    set: (key: string, value: unknown) => void;
  };
  client: {
    session: {
      get: (
        parameters: { sessionID: string },
        options?: { signal?: AbortSignal }
      ) => Promise<unknown>;
    };
  };
  lifecycle: {
    onDispose: (fn: () => void) => unknown;
  };
  event?: {
    on: (event: string, handler: (event: unknown) => void) => () => void;
  };
  renderer: { requestRender: () => void };
};

type ResolveTask = {
  sessionID: string;
  rootPromise: Promise<string | null>;
};

export function createStateSection(api: SectionApi, baseDir: string) {
  const [enabled, setEnabled] = createSignal<boolean>(api.kv.get(KV_SIDEBAR_ENABLED, true));
  const [open, setOpen] = createSignal<boolean>(api.kv.get(KV_SECTION_OPEN, true));

  let lastDetails: string[] | null = null;
  const [activeRoot, setActiveRoot] = createSignal<string | null>(null);
  let currentTask: ResolveTask | null = null;

  function getLastDetails(): string[] | null {
    return lastDetails;
  }

  function getActiveRoot(): string | null {
    return activeRoot();
  }

  function watchRuntime(onChange: () => void): () => void {
    const directories = [...new Set(runtimeDirs(baseDir))];
    const watchTargets = [
      ...directories,
      ...directories.map((directory) => dirname(directory)),
    ].filter((directory, index, all) => all.indexOf(directory) === index && existsSync(directory));
    const watchers = watchTargets.flatMap((directory) => {
      try {
        return [watchFs(directory, { persistent: false }, () => onChange())];
      } catch {
        return [];
      }
    });
    return () => watchers.forEach((watcher) => watcher.close());
  }

  async function resolveRoot(sid: string, signal?: AbortSignal): Promise<string | null> {
    const visited = new Set<string>();
    let current = sid;
    while (!visited.has(current)) {
      if (signal?.aborted) return null;
      visited.add(current);
      try {
        const result = await api.client.session.get(
          { sessionID: current },
          signal ? { signal } : undefined
        );
        const session = (result as { data?: unknown }).data as SessionLike | undefined;
        if (!session || typeof session.id !== 'string') return null;
        const parent = session.parentID;
        if (typeof parent !== 'string' || parent === '') return session.id;
        current = parent;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function onSession(sessionID: string | undefined): Promise<void> {
    if (typeof sessionID !== 'string' || sessionID === '') {
      currentTask = null;
      setActiveRoot(null);
      lastDetails = null;
      return;
    }

    const task: ResolveTask = {
      sessionID,
      rootPromise: resolveRoot(sessionID),
    };
    currentTask = task;

    try {
      const root = await task.rootPromise;
      if (currentTask !== task) return; // вытеснено

      setActiveRoot(root);
    } catch {
      if (currentTask !== task) return;
      setActiveRoot(null);
    }
  }

  async function loadProfiles(): Promise<ProfileMetadata[]> {
    const directories = profileDirs(baseDir);
    for (const dir of directories) {
      if (!existsSync(dir)) continue;
      try {
        const profiles = await listProfiles(dir);
        if (profiles.length > 0) return profiles;
      } catch {
        // Try the next compatible profile location.
      }
    }
    return [];
  }

  function getDetailsText(profiles: ProfileMetadata[]): string {
    return lastDetails !== null
      ? lastDetails.join('\n')
      : profiles.length > 0
        ? `No active workflow session.\nAvailable profiles:\n${profiles
            .map((pr) => `  · ${pr.id}${pr.description ? ` — ${pr.description}` : ''}`)
            .join('\n')}`
        : 'No active workflow session.\nSet STATE_MACHINE_PROFILES_DIR or create a profile.';
  }

  function showDetails(msg: string): void {
    showTextDialog(DETAILS_TITLE, msg);
  }

  function showTextDialog(title: string, msg: string): void {
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title,
        message: msg,
        onConfirm: () => api.ui.dialog.clear(),
      })
    );
  }

  function openDetails(currentLine: string | null): void {
    if (currentLine !== null || lastDetails !== null) {
      showDetails(
        currentLine !== null ? (lastDetails?.join('\n') ?? currentLine) : lastDetails!.join('\n')
      );
      return;
    }
    void loadProfiles().then((profiles) => showDetails(getDetailsText(profiles)));
  }

  function openProfileSchemas(profileId: string): void {
    void resolveConfig(profileId, profileDirs(baseDir)[0])
      .then((profile) => {
        showSchemaList(profileId, profile.schemas);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        showDetails(`Unable to load schemas for profile ${profileId}: ${message}`);
      });
  }

  function showSchemaList(profileId: string, schemas: ResolvedSchema[]): void {
    api.ui.dialog.setSize('large');
    api.ui.dialog.replace(() => (
      <SchemaListDialog
        profileId={profileId}
        schemas={schemas}
        onSelect={(schema) => showSchemaDetails(profileId, schemas, schema)}
        onClose={() => api.ui.dialog.clear()}
      />
    ));
  }

  function showSchemaDetails(
    profileId: string,
    schemas: ResolvedSchema[],
    schema: ResolvedSchema
  ): void {
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => (
      <SchemaDetailsDialog
        source={schema.source}
        details={formatSchemaDetails(schema)}
        onBack={() => showSchemaList(profileId, schemas)}
        onClose={() => api.ui.dialog.clear()}
      />
    ));
  }

  function toggleVisibility(): void {
    const next = !enabled();
    setEnabled(next);
    api.kv.set(KV_SIDEBAR_ENABLED, next);
    api.renderer.requestRender();
  }

  function toggleOpen(): void {
    const next = !open();
    setOpen(next);
    api.kv.set(KV_SECTION_OPEN, next);
    api.renderer.requestRender();
  }

  return {
    enabled,
    open,
    openDetails,
    openProfileSchemas,
    toggleVisibility,
    toggleOpen,
    onSession,
    getActiveRoot,
    watchRuntime,
    getLastDetails,
    loadProfiles,
    setLastDetails: (d: string[] | null) => {
      lastDetails = d;
    },
  };
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '""';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

function gateTone(status: string): 'success' | 'warning' | 'error' | 'muted' {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running' || status === 'pending') return 'warning';
  return 'muted';
}

function guardRows(
  view: Tui
): Array<{ label: string; value: string; tone: 'success' | 'warning' | 'error' | 'muted' }> {
  const guards = view.raw.guards;
  if (Array.isArray(guards)) {
    return guards.slice(0, 3).map((guard, index) => ({
      label: `guard.${index + 1}`,
      value: compactValue(guard),
      tone: 'muted',
    }));
  }
  if (guards && typeof guards === 'object') {
    return Object.entries(guards)
      .slice(0, 3)
      .map(([key, value]) => ({
        label: `guard.${key}`,
        value: compactValue(value),
        tone: value === true ? 'success' : value === false ? 'error' : 'warning',
      }));
  }
  return [];
}

type AvailableStage = { id: string; status: 'allowed' | 'blocked' | 'unknown'; blockedBy?: string };
type StageNeighbors = { previous: string | null; next: string | null; available: AvailableStage[] };

type SessionGuardSnapshot = {
  view: Tui | null;
  profiles: ProfileMetadata[];
  neighbors: StageNeighbors;
};

type SessionGuardCoordinator = {
  refresh: () => void;
  setSession: (sessionId: string | undefined) => void;
  dispose: () => void;
};

async function resolveStageNeighbors(
  profileId: string,
  stage: string,
  baseDir: string,
  rawSession?: Record<string, unknown>
): Promise<StageNeighbors> {
  for (const dir of profileDirs(baseDir)) {
    if (!existsSync(dir)) continue;
    try {
      const profile = await resolveConfig(profileId, dir);
      const transitions = profile.schemas.flatMap((schema) => schema.transitions ?? []);
      const outgoing = transitions.filter((transition) => transition.from === stage);
      const parsedSession = rawSession ? WorkflowSessionSchema.safeParse(rawSession) : null;
      const facts = parsedSession?.success
        ? {
            ...toSessionFacts(parsedSession.data),
            requiredGates:
              [...profile.schemas].reverse().find((schema) => schema.requiredGates !== undefined)
                ?.requiredGates ?? [],
          }
        : undefined;
      const available = [
        ...new Map(outgoing.map((transition) => [transition.to, transition])).entries(),
      ].map(([id, transition]) => {
        if (!facts) return { id, status: 'unknown' as const };
        const result = checkTransition(stage, id, transitions, facts);
        if (result.allowed) return { id, status: 'allowed' as const };
        const reason = result.reason ?? '';
        const blockedBy =
          transition.consent && reason.includes('approval')
            ? `consent:${typeof transition.consent === 'string' ? transition.consent : transition.consent.type}`
            : reason.includes('guard')
              ? 'guard'
              : reason.includes('gate')
                ? 'gate'
                : undefined;
        return { id, status: 'blocked' as const, blockedBy };
      });
      return {
        previous: transitions.find((transition) => transition.to === stage)?.from ?? null,
        next: available[0]?.id ?? null,
        available,
      };
    } catch {
      // Try the next compatible profile location.
    }
  }
  return { previous: null, next: null, available: [] };
}

function readSessionView(
  section: ReturnType<typeof createStateSection>,
  baseDir: string
): Tui | null {
  const id = section.getActiveRoot();
  if (id === null) {
    section.setLastDetails(null);
    return null;
  }
  const raw = readRuntimeFile(id, baseDir);
  if (raw === null) {
    section.setLastDetails(null);
    return null;
  }
  const parsed = parseRuntimeState(raw);
  if (!parsed.ok) {
    section.setLastDetails(null);
    return null;
  }
  section.setLastDetails(formatDetailsLines(raw) ?? [`runId: ${String(parsed.value.raw.runId)}`]);
  return parsed.value;
}

export function createSessionGuardCoordinator(options: {
  section: ReturnType<typeof createStateSection>;
  api: SectionApi;
  baseDir: string;
  onUpdate: (snapshot: SessionGuardSnapshot) => void;
}): SessionGuardCoordinator {
  let currentSessionId: string | undefined;
  let generation = 0;
  let active = false;
  let pendingRefresh = false;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const stops: Array<() => void> = [];

  const schedule = (): void => {
    if (disposed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (active) {
        pendingRefresh = true;
        return;
      }
      void load();
    }, 150);
  };

  const load = async (): Promise<void> => {
    if (disposed || active) return;
    active = true;
    const mine = ++generation;
    const sessionId = currentSessionId;
    try {
      await options.section.onSession(sessionId);
      if (disposed || mine !== generation) return;
      const view = readSessionView(options.section, options.baseDir);
      const profiles = await options.section.loadProfiles();
      if (disposed || mine !== generation) return;
      const profileId = typeof view?.raw.profileId === 'string' ? view.raw.profileId : null;
      const neighbors =
        profileId && view
          ? await resolveStageNeighbors(profileId, view.stage, options.baseDir, view.raw)
          : { previous: null, next: null, available: [] };
      if (disposed || mine !== generation) return;
      options.onUpdate({ view, profiles, neighbors });
      options.api.renderer.requestRender();
    } finally {
      active = false;
      if (!disposed && pendingRefresh) {
        pendingRefresh = false;
        schedule();
      }
    }
  };

  const notify = (): void => schedule();
  stops.push(options.section.watchRuntime(notify));
  for (const event of ['session.created', 'session.updated', 'session.status']) {
    try {
      if (options.api.event) stops.push(options.api.event.on(event, notify));
    } catch {
      // Hosts without the optional event bus still work through the file watcher.
    }
  }
  pollTimer = setInterval(notify, 10000);
  schedule();

  return {
    refresh: schedule,
    setSession: (sessionId) => {
      if (currentSessionId === sessionId) return;
      currentSessionId = sessionId;
      generation++;
      schedule();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation++;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      stops.splice(0).forEach((stop) => stop());
    },
  };
}

function sessionSummaryRows(
  view: Tui
): Array<{ label: string; value: string; tone: 'success' | 'warning' | 'error' | 'muted' }> {
  const raw = view.raw;
  const rows: Array<{
    label: string;
    value: string;
    tone: 'success' | 'warning' | 'error' | 'muted';
  }> = [];
  if (typeof raw.profileId === 'string')
    rows.push({ label: 'profile', value: raw.profileId, tone: 'muted' });
  rows.push({ label: 'revision', value: String(view.revision), tone: 'muted' });

  const approvals = Array.isArray(raw.approvals) ? raw.approvals : [];
  if (approvals.length > 0) {
    rows.push({
      label: 'approvals',
      value: approvals
        .filter(isRecord)
        .map(
          (approval) =>
            `${String(approval.type ?? 'unknown')}=${String(approval.status ?? 'unknown')}`
        )
        .join(' '),
      tone: approvals.some((approval) => isRecord(approval) && approval.status === 'rejected')
        ? 'error'
        : 'success',
    });
  }

  const pending = Array.isArray(raw.pendingDecisions) ? raw.pendingDecisions.length : 0;
  if (pending > 0)
    rows.push({ label: 'pending decisions', value: String(pending), tone: 'warning' });

  const violations = Array.isArray(raw.invariantViolations) ? raw.invariantViolations.length : 0;
  if (violations > 0) rows.push({ label: 'violations', value: String(violations), tone: 'error' });

  const operations = isRecord(raw.activeOperations) ? Object.keys(raw.activeOperations).length : 0;
  if (operations > 0)
    rows.push({ label: 'operations', value: String(operations), tone: 'warning' });
  rows.push({
    label: 'tasks',
    value: `${view.completedTasks}/${view.totalTasks} completed`,
    tone: 'muted',
  });
  return rows;
}

function formatSchemaDetails(schema: ResolvedSchema): string {
  return JSON.stringify(schema, null, 2);
}

function SchemaListDialog(props: {
  profileId: string;
  schemas: ResolvedSchema[];
  onSelect: (schema: ResolvedSchema) => void;
  onClose: () => void;
}): JSX.Element {
  const [selected, setSelected] = createSignal(0);
  const selectCurrent = (): void => {
    const schema = props.schemas[selected()];
    if (schema) props.onSelect(schema);
  };
  const handleKeyDown = (event: KeyEvent): void => {
    if (event.name === 'UP' || event.name === 'ARROWUP') {
      setSelected((index) => Math.max(0, index - 1));
      event.preventDefault();
      return;
    }
    if (event.name === 'DOWN' || event.name === 'ARROWDOWN') {
      setSelected((index) => Math.min(props.schemas.length - 1, index + 1));
      event.preventDefault();
      return;
    }
    if (event.name === 'ENTER') {
      selectCurrent();
      event.preventDefault();
      return;
    }
    if (event.name === 'ESCAPE') {
      props.onClose();
      event.preventDefault();
    }
  };
  return (
    <box
      width="100%"
      flexDirection="column"
      border
      borderColor="#888"
      padding={1}
      focusable
      onKeyDown={handleKeyDown}
    >
      <text>Profile: {props.profileId}</text>
      <text>Available schemas:</text>
      <Show when={props.schemas.length > 0} fallback={<text>No schemas configured.</text>}>
        <For each={props.schemas}>
          {(schema) => (
            <text
              onMouseUp={() => props.onSelect(schema)}
              fg={schema === props.schemas[selected()] ? '#fff' : '#888'}
            >
              {'› '}
              {schema.source}
            </text>
          )}
        </For>
      </Show>
      <text onMouseUp={props.onClose} fg="#888">
        Close
      </text>
    </box>
  );
}

function SchemaDetailsDialog(props: {
  source: string;
  details: string;
  onBack: () => void;
  onClose: () => void;
}): JSX.Element {
  const handleKeyDown = (event: KeyEvent): void => {
    if (event.name === 'ESCAPE' || event.name === 'BACKSPACE') {
      props.onBack();
      event.preventDefault();
    }
  };
  return (
    <box
      width="100%"
      flexDirection="column"
      border
      borderColor="#888"
      padding={1}
      focusable
      onKeyDown={handleKeyDown}
    >
      <text>Schema: {props.source}</text>
      <scrollbox height={20} flexGrow={1}>
        <text>{props.details}</text>
      </scrollbox>
      <box width="100%" flexDirection="row" gap={2}>
        <text onMouseUp={props.onBack} fg="#888">
          Back
        </text>
        <text onMouseUp={props.onClose} fg="#888">
          Close
        </text>
      </box>
    </box>
  );
}

// ── SidebarContent — SolidJS component with filesystem/event reactivity ─────
function WorkflowSidebarContent(props: {
  api: TuiPluginApi;
  section: ReturnType<typeof createStateSection>;
  sessionId?: string;
  snapshot: () => SessionGuardSnapshot;
  coordinator: SessionGuardCoordinator;
}) {
  createEffect(() => {
    props.coordinator.setSession(props.sessionId);
  });

  const sessionView = (): Tui | null => props.snapshot().view;
  const profiles = (): ProfileMetadata[] => props.snapshot().profiles;
  const neighbors = (): StageNeighbors => props.snapshot().neighbors;

  const theme = props.api.theme.current;
  const view = () => sessionView();
  const color = (tone: 'success' | 'warning' | 'error' | 'muted'): string => {
    const themeColors = {
      success: theme.success,
      warning: theme.warning,
      error: theme.error,
      muted: theme.textMuted,
    };
    return (themeColors[tone] as unknown as string) ?? (theme.text as unknown as string) ?? '#ccc';
  };
  const previousStage = () => neighbors().previous ?? view()?.prevStage ?? null;
  const nextStage = () => neighbors().next ?? view()?.nextStage ?? null;
  const availableStages = () => {
    const availableStages = neighbors().available;
    return availableStages.length > 0
      ? availableStages
          .map((stage) => {
            const marker =
              stage.status === 'allowed' ? '✓' : stage.status === 'blocked' ? '×' : '?';
            return `${stage.id} ${marker}${stage.blockedBy ? ` [${stage.blockedBy}]` : ''}`;
          })
          .join(', ')
      : (nextStage() ?? '—');
  };
  const title = () =>
    view()?.stage ?? (view()?.raw.title ? compactValue(view()!.raw.title) : 'Workflow');
  const panelPalette = createMemo(() =>
    buildPanelPalette(theme as unknown as Record<string, unknown>)
  );
  const layout = createPanelLayout({ border: createMemo(() => false) });

  return (
    <Show when={props.section.enabled()}>
      <TuiPanel pal={panelPalette()} border={false} layout={layout}>
        <TuiSection
          pal={panelPalette()}
          layout={layout}
          open={props.section.open}
          onToggle={() => props.section.toggleOpen()}
          onHide={() => props.section.toggleVisibility()}
          title={title()}
        >
          <Show
            when={view()}
            fallback={
              <box width="100%" flexDirection="column" flexShrink={0}>
                <text fg={color('muted')}>Available profiles</text>
                <Show
                  when={profiles().length > 0}
                  fallback={<text fg={color('muted')}>No workflow profiles found</text>}
                >
                  <For each={profiles()}>
                    {(profile) => (
                      <text
                        onMouseUp={() => props.section.openProfileSchemas(profile.id)}
                        fg={color('muted')}
                      >
                        <span style={{ fg: color('success') }}>● </span>
                        {profile.id}
                        {profile.description ? ` — ${profile.description}` : ''}
                      </text>
                    )}
                  </For>
                </Show>
              </box>
            }
          >
            {(current) => (
              <box
                width="100%"
                flexDirection="column"
                flexShrink={0}
                onMouseUp={() => props.section.openDetails(null)}
              >
                <text fg={(theme.accent as unknown as string) ?? color('success')}>
                  current: {current().stage}
                </text>
                <For each={current().gates}>
                  {(gate) => (
                    <text fg={color(gateTone(gate.status))}>
                      gate.{gate.id}: {gate.status}
                    </text>
                  )}
                </For>
                <For each={guardRows(current())}>
                  {(guard) => (
                    <text fg={color(guard.tone)}>
                      {guard.label}: {guard.value}
                    </text>
                  )}
                </For>
                <For each={sessionSummaryRows(current())}>
                  {(row) => (
                    <text
                      fg={
                        row.label === 'profile'
                          ? (theme.primary as unknown as string)
                          : row.label === 'revision'
                            ? (theme.secondary as unknown as string)
                            : color(row.tone)
                      }
                    >
                      {row.label}: {row.value}
                    </text>
                  )}
                </For>
                <Show when={current().activeMutation}>
                  <text fg={color('warning')}>
                    active: {current().activeMutation?.agent || current().activeMutation?.taskId}
                  </text>
                </Show>
                <text width="100%" fg={(theme.info as unknown as string) ?? color('warning')}>
                  ──────── available: {availableStages()} ────────
                </text>
              </box>
            )}
          </Show>
        </TuiSection>
      </TuiPanel>
    </Show>
  );
}

function HomeProfiles(props: {
  api: TuiPluginApi;
  section: ReturnType<typeof createStateSection>;
  snapshot: () => SessionGuardSnapshot;
}) {
  const theme = props.api.theme.current;
  const color = (
    key: 'primary' | 'text' | 'textMuted' | 'success' | 'warning' | 'accent' | 'info'
  ): string => (theme[key] as unknown as string) ?? '#ccc';

  return (
    <Show when={props.section.enabled()}>
      <box width="100%" flexDirection="column" flexShrink={0}>
        <box width="100%" flexDirection="row" gap={1}>
          <box width={2} flexShrink={0}>
            <text fg={color('textMuted')}>▼</text>
          </box>
          <box flexGrow={1} minWidth={0} alignItems="center">
            <text onMouseUp={() => props.section.openDetails(null)} fg={color('primary')}>
              <b>Workflow profiles</b>
            </text>
          </box>
          <box width={2} flexShrink={0} alignItems="flex-end">
            <text onMouseUp={() => props.section.toggleVisibility()} fg={color('textMuted')}>
              ✕
            </text>
          </box>
        </box>
        <text fg={color('info')}>Available profiles</text>
        <Show
          when={props.snapshot().profiles.length > 0}
          fallback={<text fg={color('warning')}>No profiles</text>}
        >
          <For each={props.snapshot().profiles}>
            {(profile) => (
              <text
                onMouseUp={() => props.section.openProfileSchemas(profile.id)}
                fg={color('textMuted')}
              >
                <span style={{ fg: color('success') }}>● </span>
                {profile.id}
                {profile.description ? ` — ${profile.description}` : ''}
              </text>
            )}
          </For>
        </Show>
      </box>
    </Show>
  );
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // OpenCode supplies the opened project's directory through the TUI API. Do
  // not derive it from the plugin bundle location or the TUI process cwd. The
  // empty fallback is only for old/test hosts that omit the state path.
  const directory = api.state?.path?.directory ?? process.env.OPENCODE_PROJECT_DIR ?? '';
  const section = createStateSection(api, directory);
  activeTestSection = section;
  const [snapshot, setSnapshot] = createSignal<SessionGuardSnapshot>({
    view: null,
    profiles: [],
    neighbors: { previous: null, next: null, available: [] },
  });
  const coordinator = createSessionGuardCoordinator({
    section,
    api,
    baseDir: directory,
    onUpdate: setSnapshot,
  });

  api.slots.register({
    order: SLOT_ORDER,
    slots: {
      sidebar_content(_ctx, props) {
        try {
          return (
            <box flexDirection="column">
              <WorkflowSidebarContent
                api={api}
                section={section}
                sessionId={(props as { session_id?: string }).session_id}
                snapshot={snapshot}
                coordinator={coordinator}
              />
              <RulesSidebarContent
                sessionId={(props as { session_id?: string }).session_id ?? ''}
                api={api}
                theme={_ctx.theme}
              />
            </box>
          );
        } catch (err) {
          console.error('[tui] sidebar_content render error:', err);
          return <text>⚠️ {String(err)}</text>;
        }
      },
      home_bottom(_ctx, props) {
        return <HomeProfiles api={api} section={section} snapshot={snapshot} />;
      },
    },
  });

  // Commands and bindings use the current OpenTUI keymap API.
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: DETAILS_COMMAND,
          namespace: 'palette',
          title: DETAILS_TITLE,
          run: () => section.openDetails(null),
        },
        {
          name: TOGGLE_COMMAND,
          namespace: 'palette',
          title: 'Toggle sidebar section',
          run: () => section.toggleVisibility(),
        },
      ],
    } as never);
    api.keymap.registerLayer({
      mode: 'base',
      bindings: [{ key: '<leader>w', cmd: DETAILS_COMMAND }],
    } as never);
  } catch {
    /* keep the widget usable if keymap registration is unavailable */
  }

  api.lifecycle.onDispose(() => coordinator.dispose());
};

export default { id, tui };

// Тестовый доступ к экземпляру, созданному в tui(); загрузчик opencode
// игнорирует именованные экспорты.
let activeTestSection: ReturnType<typeof createStateSection> | null = null;
export function __sectionForTests() {
  return activeTestSection;
}
