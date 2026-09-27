/** A bare git commit is refused inside a governed session */

import { ORCHESTRATOR, newSession, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const gitBlock: Scenario = {
  id: 'git-block',
  title: 'A bare git commit is refused inside a governed session',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'git-block');
    await step(host, sessionId, model, {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create did not run',
    });
    const result = await step(host, sessionId, model, {
      instruction:
        'Use the bash tool to run exactly this command: git commit --allow-empty -m "smoke". ' +
        'Report what happened, verbatim.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        const refused = /not allowed|refus|blocked|workflow|no entry covers/i.test(s.transcript);
        return refused || 'the commit was not refused';
      },
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'the host cancelled the tool call and surfaced the workflow reason'
        : `${result.detail}\n${result.session.transcript.slice(0, 800)}`,
    };
  },
};
