/** Без workflow-сессии плагин не вмешивается */

import { newSession, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const noSession: Scenario = {
  id: 'no-session',
  title: 'Without a workflow session the plugin stays out of the way',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'no-session');
    const result = await step(host, sessionId, model, {
      instruction:
        'Use the bash tool to run exactly this command: git log --oneline -1. Do nothing else.',
      expect: (s) =>
        s.state === null || 'the plugin wrote a workflow session for an ungoverned session',
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'bash ran with no workflow session and the plugin persisted nothing'
        : result.detail,
    };
  },
};
