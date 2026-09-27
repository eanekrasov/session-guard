/** Утверждённый план выводит сессию из planning */

import { CONSENT_INSTRUCTION, ORCHESTRATOR, newSession, stage, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const planConsent: Scenario = {
  id: 'plan-consent',
  title: 'Одобренный план переводит сессию из стадии planning',
  // Обычно оператор отвечает на вопрос согласия. `HARNESS_AUTO_APPROVE`
  // — поставляемая опция для автоматизации; сторона отказа покрыта
  // сценарием `commit-gate`, который запускается без неё.
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'plan-consent');
    await step(host, sessionId, model, {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create не выполнился',
    });
    const result = await step(host, sessionId, model, {
      instruction: CONSENT_INSTRUCTION,
      agent: ORCHESTRATOR,
      expect: (s) => {
        const refs = (s.state as { refs?: Record<string, string> } | null)?.refs ?? {};
        if (!refs.plan) return 'ссылка на план не была записана';
        const currentStage = stage(s);
        return currentStage === 'tasks_ready' || `стадия — ${currentStage}, ожидалась tasks_ready`;
      },
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'согласие сохранило ссылку на план, и гейт открыл переход planning → tasks_ready'
        : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
    };
  },
};
