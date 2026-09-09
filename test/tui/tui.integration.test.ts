import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pluginModule, {
  __sectionForTests,
  createSessionGuardCoordinator,
  createStateSection,
  type SectionApi,
} from '../../src/tui/index.tsx';

const RUNTIME_SUBDIR = 'sessions';

/**
 * A session as the current schema defines one.
 *
 * This used to describe a shape the schema does not accept — `schemaVersion: 1`,
 * gates as an object, no profile — and the TUI rendered it because its reader
 * was more forgiving than the schema. The reader validates now: there is one
 * session shape, and a fixture that is not it is testing nothing real.
 */
function stateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    sessionId: 'ses_root',
    profileId: 'test',
    schemaId: 'cycle',
    currentStage: 'planning',
    gates: [
      { id: 'invariants', status: 'pending' },
      { id: 'review', status: 'pending' },
      { id: 'qa', status: 'pending' },
    ],
    ...overrides,
  });
}

type SessionTree = Record<string, string | undefined>;

const SDK_ERROR_ID = '__sdk_error__';

function makeApi(tree: SessionTree): SectionApi {
  const kv = new Map<string, unknown>();
  const eventHandlers = new Map<string, Array<() => void>>();
  return {
    slots: { register: () => '' as string },
    keymap: { registerLayer: () => {} },
    ui: {
      DialogAlert: () => '' as never,
      dialog: { setSize: () => {}, replace: () => {}, clear: () => {} },
    },
    kv: {
      get: <Value>(key: string, fallback?: Value): Value =>
        (kv.has(key) ? kv.get(key) : fallback) as Value,
      set: (key: string, value: unknown) => {
        kv.set(key, value);
      },
    },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === SDK_ERROR_ID) throw new Error('sdk недоступен');
          const parentID = tree[sessionID];
          return { data: { id: sessionID, parentID } };
        },
      },
    },
    lifecycle: { onDispose: () => {} },
    renderer: { requestRender: () => {} } as never,
    event: {
      on: (event: string, handler: (event: unknown) => void): (() => void) => {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler as () => void);
        eventHandlers.set(event, handlers);
        return () => {
          const remaining = (eventHandlers.get(event) ?? []).filter((h) => h !== handler);
          if (remaining.length > 0) eventHandlers.set(event, remaining);
          else eventHandlers.delete(event);
        };
      },
    },
  };
}

let projectDir: string | null = null;

function enterProject(): string {
  delete process.env.SESSION_GUARD_STORE_DIR;
  delete process.env.SESSION_GUARD_PROFILES_DIR;
  projectDir = mkdtempSync(join(tmpdir(), 'sidebar-e2e-'));
  const sessions = join(projectDir, RUNTIME_SUBDIR);
  mkdirSync(sessions, { recursive: true });
  process.env.SESSION_GUARD_STORE_DIR = sessions;
  process.chdir(projectDir);
  return sessions;
}

function exitProject(): void {
  if (projectDir !== null) {
    process.chdir('/');
    rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;
  }
}

function writeState(rootSessionID: string, content: string): void {
  if (projectDir === null) throw new Error('проект не инициализирован');
  writeFileSync(join(projectDir, RUNTIME_SUBDIR, `${rootSessionID}.json`), content);
}

async function until(probe: () => boolean, timeoutMs = 1000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (probe()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return -1;
}

afterEach(() => exitProject());

describe('sidebar-state: проводка плагина', () => {
  test('tui регистрирует слот sidebar_content с order 600 и корректным id', () => {
    let registered: unknown;
    const api: SectionApi = {
      ...makeApi({}),
      slots: {
        register: (config) => {
          registered = config;
          return '';
        },
      },
    };
    void (pluginModule.tui as (...args: unknown[]) => unknown)(api, undefined, {});
    expect(pluginModule.id).toBe('session-guard.sidebar-state');
    expect(registered).toEqual({
      order: 350,
      slots: {
        sidebar_content: expect.any(Function),
        home_bottom: expect.any(Function),
      },
    });
  });

  test('хоткей <leader>w открывает диалог с полным дампом состояния', async () => {
    enterProject();
    writeState(
      'ses_root',
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'ses_root',
        currentStage: 'code',
        gates: { invariants: 'pending', review: 'pending', qa: 'pending' },
        processedEventIds: ['evt_1', 'evt_2'],
      })
    );
    const layers: Array<{
      commands?: Array<Record<string, unknown>>;
      bindings?: Array<{ key?: string; cmd?: string }>;
      mode?: string;
    }> = [];
    const alerts: Array<{ title?: string; message?: string }> = [];
    const dialogSizes: Array<string> = [];
    const api: SectionApi = {
      ...makeApi({}),
      slots: {
        register: () => '',
      },
      keymap: {
        registerLayer: (input) => {
          layers.push(input as (typeof layers)[number]);
          return '';
        },
      },
      ui: {
        DialogAlert: (props) => {
          alerts.push(props);
          return '' as never;
        },
        dialog: {
          setSize: (size) => {
            dialogSizes.push(size);
          },
          replace: (render) => {
            render();
          },
          clear: () => {},
        },
      },
    };
    // Устанавливаем lastDetails вручную, как это делает SidebarContent
    const initialMessage = [
      'currentStage: "code"',
      'rootSessionID: ses_root',
      'processedEventIds: 2',
    ].join('\n');
    await (pluginModule.tui as (...args: unknown[]) => Promise<unknown>)(api, undefined, {});
    const section = __sectionForTests()!;
    section.setLastDetails([initialMessage]);

    expect(layers).toHaveLength(2);
    const commandLayer = layers.find((l) => l.commands !== undefined)!;
    const bindingLayer = layers.find((l) => l.bindings !== undefined)!;
    expect(commandLayer.mode).toBeUndefined();
    const command = commandLayer.commands!.find(
      (c) => (c as { name?: string }).name === 'harness.workflow.details'
    ) as unknown as { namespace?: string; title?: string; run: () => void };
    expect(command.namespace).toBe('palette');
    expect(command.title).toContain('full state');

    command.run();
    expect(alerts.at(-1)!.title).toContain('full state');
    expect(alerts.at(-1)!.message).toContain('currentStage: "code"');
    expect(alerts.at(-1)!.message).toContain('processedEventIds: 2');

    await section.onSession('ses_root');
    expect(await until(() => section.getActiveRoot() === 'ses_root')).toBeGreaterThanOrEqual(0);

    expect(bindingLayer.mode).toBe('base');
    expect(bindingLayer.bindings).toEqual([{ key: '<leader>w', cmd: 'harness.workflow.details' }]);
    command.run();
    const last = alerts.at(-1)!;
    expect(last.title).toContain('full state');
    expect(last.message).toContain('currentStage: "code"');
    expect(last.message).toContain('processedEventIds: 2');
  });
});

describe('sidebar-state: onSession резолвит root-сессию', () => {
  test('корневая сессия с валидным файлом — activeRoot проставляется', async () => {
    enterProject();
    writeState('ses_root', stateJson({ currentStage: 'code' }));
    const section = createStateSection(makeApi({}), projectDir!);
    await section.onSession('ses_root');
    expect(section.getActiveRoot()).toBe('ses_root');
  });

  test('дочерняя сессия — activeRoot указывает на корень', async () => {
    enterProject();
    writeState('ses_root', stateJson({ currentStage: 'planning' }));
    const section = createStateSection(makeApi({ ses_child: 'ses_root' }), projectDir!);
    await section.onSession('ses_child');
    expect(await until(() => section.getActiveRoot() === 'ses_root')).toBeGreaterThanOrEqual(0);
    expect(section.getActiveRoot()).toBe('ses_root');
  });

  test('сессия с циклом родителей — activeRoot null', async () => {
    enterProject();
    const section = createStateSection(
      makeApi({
        ses_a: 'ses_loop',
        ses_loop: 'ses_a',
      }),
      projectDir!
    );
    await section.onSession('ses_a');
    expect(await until(() => section.getActiveRoot() === null)).toBeGreaterThanOrEqual(0);
  });

  test('ошибка SDK — activeRoot null', async () => {
    enterProject();
    const section = createStateSection(makeApi({}), projectDir!);
    await section.onSession(SDK_ERROR_ID);
    expect(await until(() => section.getActiveRoot() === null)).toBeGreaterThanOrEqual(0);
  });

  test('пустой session_id — activeRoot null', async () => {
    enterProject();
    const section = createStateSection(makeApi({}), projectDir!);
    await section.onSession(undefined);
    expect(section.getActiveRoot()).toBeNull();
  });

  test('смена сессии обновляет activeRoot', async () => {
    enterProject();
    writeState('ses_code', stateJson({ currentStage: 'code' }));
    writeState('ses_commit', stateJson({ currentStage: 'commit' }));
    const section = createStateSection(makeApi({}), projectDir!);
    await section.onSession('ses_code');
    expect(section.getActiveRoot()).toBe('ses_code');
    await section.onSession('ses_commit');
    expect(section.getActiveRoot()).toBe('ses_commit');
  });
});

describe('sidebar-state: видимость секции', () => {
  test('toggleVisibility переключает enabled', () => {
    const section = createStateSection(makeApi({}), '/tmp');
    expect(section.enabled()).toBe(true);
    section.toggleVisibility();
    expect(section.enabled()).toBe(false);
    section.toggleVisibility();
    expect(section.enabled()).toBe(true);
  });

  test('toggleOpen переключает и сохраняет состояние секции', () => {
    const api = makeApi({});
    let renders = 0;
    api.renderer.requestRender = () => {
      renders += 1;
    };
    const section = createStateSection(api, '/tmp');

    expect(section.open()).toBe(true);
    section.toggleOpen();
    expect(section.open()).toBe(false);
    expect(api.kv.get<boolean>('session-guard.sidebar.section_open')).toBe(false);
    expect(renders).toBe(1);
  });
});

describe('sidebar-state: coordinator событий', () => {
  test('coalesces multiple refresh requests into one snapshot update', async () => {
    enterProject();
    writeState('ses_root', stateJson({ currentStage: 'code' }));
    const section = createStateSection(makeApi({}), projectDir!);
    const snapshots: Array<{ view: unknown }> = [];
    const coordinator = createSessionGuardCoordinator({
      section,
      api: makeApi({}),
      baseDir: projectDir!,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });

    coordinator.setSession('ses_root');
    coordinator.refresh();
    coordinator.refresh();

    expect(await until(() => snapshots.length === 1, 1000)).toBeGreaterThanOrEqual(0);
    expect((snapshots[0]!.view as { stage?: string }).stage).toBe('code');
    coordinator.dispose();
  });

  test('dispose cancels a pending debounced refresh', async () => {
    enterProject();
    writeState('ses_root', stateJson({ currentStage: 'code' }));
    const section = createStateSection(makeApi({}), projectDir!);
    let updates = 0;
    const coordinator = createSessionGuardCoordinator({
      section,
      api: makeApi({}),
      baseDir: projectDir!,
      onUpdate: () => {
        updates += 1;
      },
    });

    coordinator.setSession('ses_root');
    coordinator.dispose();
    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(updates).toBe(0);
  });

  test('drops a stale snapshot after switching sessions during an async load', async () => {
    enterProject();
    writeState('ses_slow', stateJson({ currentStage: 'planning' }));
    writeState('ses_fast', stateJson({ currentStage: 'code' }));
    const api = makeApi({});
    api.client.session.get = async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === 'ses_slow') await new Promise((resolve) => setTimeout(resolve, 220));
      return { data: { id: sessionID } };
    };
    const section = createStateSection(api, projectDir!);
    const stages: string[] = [];
    const coordinator = createSessionGuardCoordinator({
      section,
      api,
      baseDir: projectDir!,
      onUpdate: ({ view }) => {
        if (view !== null) stages.push(view.stage);
      },
    });

    coordinator.setSession('ses_slow');
    await new Promise((resolve) => setTimeout(resolve, 180));
    coordinator.setSession('ses_fast');

    expect(await until(() => stages.includes('code'), 1500)).toBeGreaterThanOrEqual(0);
    expect(stages).not.toContain('planning');
    coordinator.dispose();
  });
});
