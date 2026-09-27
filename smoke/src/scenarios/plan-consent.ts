/** An approved plan moves the session out of planning */

import { CONSENT_INSTRUCTION, ORCHESTRATOR, newSession, stage, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const planConsent: Scenario = {
  id: 'plan-consent',
  title: 'An approved plan moves the session out of planning',
  // The operator normally answers the consent question. `HARNESS_AUTO_APPROVE`
  // is the shipped affordance for automation; the refusal side is covered by
  // `commit-gate`, which runs without it.
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'plan-consent');
    await step(host, sessionId, model, {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create did not run',
    });
    const result = await step(host, sessionId, model, {
      instruction: CONSENT_INSTRUCTION,
      agent: ORCHESTRATOR,
      expect: (s) => {
        const refs = (s.state as { refs?: Record<string, string> } | null)?.refs ?? {};
        if (!refs.plan) return 'the plan reference was never recorded';
        const currentStage = stage(s);
        return currentStage === 'tasks_ready' || `stage is ${currentStage}, expected tasks_ready`;
      },
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'consent recorded the plan reference and the guard released planning → tasks_ready'
        : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
    };
  },
};
