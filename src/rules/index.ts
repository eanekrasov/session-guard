/**
 * OpenCode Rules — test utilities export.
 *
 * This module is no longer a plugin entry point. The rules subsystem
 * is instantiated inside StateMachineRuntime.
 */

import { SessionStore, type SessionState } from './session-store.js';
import { MatchedRulesStateStore } from './matched-rules-state.js';
import { OpenCodeRulesRuntime } from './runtime.js';
import { discoverRuleFiles, clearRuleCache, type DiscoveredRule } from './rule-discovery.js';

const sessionStore = new SessionStore();
const matchedRulesStateStore = new MatchedRulesStateStore();

/**
 * Test-only exports for accessing internal state and functions.
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
        client: (input?.client ?? {}) as Record<string, unknown>,
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

// Retained for test compatibility — tests destructure { default: { id, server } }
// The server() function returns plugin hooks built from the shared runtime,
// so legacy tests that call `await plugin(input)` get real hooks.
const server = async (pluginInput?: unknown): Promise<Record<string, unknown>> => {
  // Clear any cached rule discovery so tests that write rules between calls get fresh results
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
    client: (input?.client ?? {}) as Record<string, unknown>,
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
