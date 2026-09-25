/**
 * OpenCode Rules — экспорт тестовых утилит.
 *
 * Этот модуль больше не является точкой входа плагина. Подсистема правил
 * инстанцируется внутри SessionGuardRuntime.
 */

import { SessionStore, type SessionState } from './session-store.js';
import { MatchedRulesStateStore } from './matched-rules-state.js';
import { OpenCodeRulesRuntime } from './runtime.js';
import { discoverRuleFiles, clearRuleCache, type DiscoveredRule } from './rule-discovery.js';
import { createV1RuntimeHostAdapter } from '../app/runtime-host-adapter.ts';

const sessionStore = new SessionStore();
const matchedRulesStateStore = new MatchedRulesStateStore();

/**
 * Test-only экспорты для доступа к внутреннему состоянию и функциям.
 * @internal - Test utilities only. Not part of public API.
 */
const __testOnly = Object.freeze(
  Object.assign(() => ({}), {
    setSessionStateLimit: (limit: number): void => {
      sessionStore.setMax(limit);
    },
    getSessionStateIDs: (): string[] => {
      return sessionStore.ids();
    },
    getSessionStateSnapshot: (sessionID: string): SessionState | undefined => {
      return sessionStore.snapshot(sessionID);
    },
    upsertSessionState: (sessionID: string, mutator: (state: SessionState) => void): void => {
      sessionStore.upsert(sessionID, mutator);
    },
    resetSessionState: (): void => {
      sessionStore.reset();
    },
    createHooksWithMatchedRulesStateStore: async (
      pluginInput: unknown,
      store: MatchedRulesStateStore
    ) => {
      const input = pluginInput as
        | {
            directory?: string;
            worktree?: string;
            client?: Record<string, unknown>;
          }
        | undefined;
      clearRuleCache();
      const ruleFiles = await discoverRuleFiles();
      const runtime = new OpenCodeRulesRuntime({
        host: createV1RuntimeHostAdapter({
          client: input?.client as never,
          directory: input?.worktree ?? input?.directory ?? '',
        }),
        directory: input?.worktree ?? input?.directory ?? '',
        projectDirectory: input?.directory ?? '',
        ruleFiles,
        matchedRulesStateStore: store,
        sessionStore,
      });
      return runtime.createTestHooks();
    },
  })
);

// Удержан для совместимости с тестами — тесты деструктурируют { default: { id, server } }
// Функция server() возвращает plugin hooks построенные из shared runtime,
// так что legacy тесты вызывающие `await plugin(input)` получают настоящие hooks.
const server = async (pluginInput?: unknown): Promise<Record<string, unknown>> => {
  // Очистить кэш rule discovery чтобы тесты пишущие правила между вызовами
  // получали свежие результаты
  clearRuleCache();
  const ruleFiles = await discoverRuleFiles();
  const input = pluginInput as
    | {
        directory?: string;
        worktree?: string;
        client?: Record<string, unknown>;
      }
    | undefined;
  const runtime = new OpenCodeRulesRuntime({
    host: createV1RuntimeHostAdapter({
      client: input?.client as never,
      directory: input?.worktree ?? input?.directory ?? '',
    }),
    directory: input?.worktree ?? input?.directory ?? '',
    projectDirectory: input?.directory ?? '',
    ruleFiles,
    matchedRulesStateStore,
    sessionStore,
  });
  return runtime.createTestHooks();
};
const id = 'opencode-rules' as const;
export default { id, server };
export { __testOnly };
