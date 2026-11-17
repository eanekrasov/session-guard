import { discoverRuleFiles } from '../rules/rule-discovery.js';
import { OpenCodeRulesRuntime } from './orchestrator.js';
import { SessionStore } from '../session/session-store.js';
import { MatchedRulesStateStore } from '../session/matched-rules-state.js';
import { createDebugLog, type DebugLog } from '../shared/debug.js';
import {
  createRuleMatchContextProvider,
  type RuleMatchContextProvider,
} from './match-context-provider.js';
import type { RuntimePort } from './runtime-port.js';

export interface CreateRuntimeOptions {
  /** Host operations port, supplied by the platform adapter (v2 host or V1 hooks). */
  port: RuntimePort;
  directory: string;
  projectDirectory: string;
  /** Already resolved to absolute paths; ignored when ruleFiles is supplied. */
  additionalRuleDirectories?: readonly string[];
  ruleFiles?: DiscoveredRuleInput[];
  sessionStore?: SessionStore;
  getCurrentStage?: (sessionID: string) => Promise<string | undefined>;
  matchContextProvider?: RuleMatchContextProvider;
  matchedRulesStateStore?: MatchedRulesStateStore;
  debugLog?: DebugLog;
}

type DiscoveredRuleInput = Awaited<ReturnType<typeof discoverRuleFiles>>[number];

/**
 * Builds the runtime with its own per-plugin stores by default. Tests may
 * inject a SessionStore (state inspection) or a MatchedRulesStateStore
 * pointed at a temp stateDir (sidebar state port).
 */
export async function createRuntime(opts: CreateRuntimeOptions): Promise<OpenCodeRulesRuntime> {
  const debugLog = opts.debugLog ?? createDebugLog();
  const ruleFiles =
    opts.ruleFiles ??
    (await discoverRuleFiles(opts.directory, opts.additionalRuleDirectories ?? []));
  debugLog(`Discovered ${ruleFiles.length} rule file(s)`);
  const matchContextProvider =
    opts.matchContextProvider ??
    createRuleMatchContextProvider({
      projectDirectory: opts.projectDirectory,
      sessionStore: opts.sessionStore,
      getCurrentStage: opts.getCurrentStage,
      debugLog,
    });
  return new OpenCodeRulesRuntime({
    directory: opts.directory,
    projectDirectory: opts.projectDirectory,
    ruleFiles,
    sessionStore: matchContextProvider.sessionStore,
    matchedRulesStateStore: opts.matchedRulesStateStore ?? new MatchedRulesStateStore(),
    matchContextProvider,
    port: opts.port,
    debugLog,
  });
}
