/** commit-task отклоняется, пока гейты не пройдены */

import { ORCHESTRATOR, newSession, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const commitGate: Scenario = {
  id: 'commit-gate',
  title: 'commit-task отклоняется, пока гейты не пройдены',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'commit-gate');
    await step(host, sessionId, model, {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create не выполнился',
    });
    const result = await step(host, sessionId, model, {
      instruction:
        'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: too early". ' +
        'Report what happened, verbatim.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        const receipt = (s.state as { deliveryReceipt?: string | null } | null)?.deliveryReceipt;
        if (receipt) return 'квитанция о поставке записана до прохождения гейтов';
        return /cannot commit|refus|not allowed/i.test(s.transcript) || 'отказ не обнаружен';
      },
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'гейт поставки отклонил вызов, и квитанция не была записана'
        : `${result.detail}\n${result.session.transcript.slice(0, 800)}`,
    };
  },
};
