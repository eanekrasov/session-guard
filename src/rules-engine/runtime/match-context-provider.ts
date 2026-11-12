import { buildRuleMatchContext } from './match-context.js';
import type { DebugLog } from '../shared/debug.js';
import { BoundedSessionMap } from '../shared/bounded-session-map.js';
import { createFileObservationContext } from '../session/file-observation-context.js';
import type { FileObservationContext } from '../session/file-observation-context.js';
import type { FileObservation } from '../session/file-observation.js';
import type { RawToolEvent } from '../session/file-observation.js';
import { SessionStore } from '../session/session-store.js';
import type { RuleMatchContext } from '../rules/rule-filter.js';

export interface RuleMatchContextProvider {
  readonly sessionStore: SessionStore;
  readonly fileObservations: FileObservationContext;
  setAvailableToolIDs(sessionID: string, toolIDs: string[]): void;
  getAvailableToolIDs(sessionID: string): string[];
  recordToolEvent(sessionID: string, event: RawToolEvent): FileObservation[];
  getMatchContext(sessionID: string, availableToolIDs?: string[]): Promise<RuleMatchContext>;
}

export function createRuleMatchContextProvider(options: {
  projectDirectory: string;
  sessionStore?: SessionStore;
  debugLog: DebugLog;
}): RuleMatchContextProvider {
  const sessionStore = options.sessionStore ?? new SessionStore();
  const fileObservations = createFileObservationContext({
    projectDirectory: options.projectDirectory,
  });
  const availableTools = new BoundedSessionMap<{ ids: string[] }>({ max: 100 });

  return {
    sessionStore,
    fileObservations,
    setAvailableToolIDs: (sessionID, ids) => {
      availableTools.ensure(sessionID, () => ({ ids: [] })).ids = [...ids];
    },
    getAvailableToolIDs: (sessionID) => [...(availableTools.get(sessionID)?.ids ?? [])],
    recordToolEvent: (sessionID, event) => {
      return fileObservations.recordToolEvent(sessionID, event);
    },
    getMatchContext: async (sessionID, availableToolIDs) => {
      const state = sessionStore.get(sessionID);
      return buildRuleMatchContext({
        fileObservations: fileObservations.getForMatching(sessionID),
        userPrompt: state?.lastUserPrompt,
        availableToolIDs: availableToolIDs ?? availableTools.get(sessionID)?.ids ?? [],
        modelID: state?.lastModelID,
        agentType: state?.lastAgentType,
        projectDirectory: options.projectDirectory,
        debugLog: options.debugLog,
      });
    },
  };
}
