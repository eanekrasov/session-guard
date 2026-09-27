/** workflow-create переводит сессию под управление машины состояний */

import { ORCHESTRATOR, newSession, stage, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const create: Scenario = {
  id: 'create',
  title: 'workflow-create передаёт сессию под управление конечного автомата',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'create');
    const result = await step(host, sessionId, model, {
      instruction:
        'Call the tool `workflow-create` with schemaId "smoke". Do nothing else and add no commentary.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        if (!s.state) return 'сессия workflow не сохранена';
        const currentStage = stage(s);
        return currentStage === 'planning' || `стадия — ${currentStage}, ожидалась planning`;
      },
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? `сессия сохранена на стадии ${stage(result.session)}`
        : `${result.detail}\n${result.session.transcript.slice(0, 600)}`,
    };
  },
};
