/** Хост загружает упакованный плагин и регистрирует его инструменты */

import { ORCHESTRATOR, newSession, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const pluginLoads: Scenario = {
  id: 'plugin-loads',
  title: 'The host loads the packed plugin and registers its tools',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'plugin-loads');
    const result = await step(host, sessionId, model, {
      instruction:
        'Call the tool `workflow-list` with no arguments, then reply with its output verbatim.',
      agent: ORCHESTRATOR,
      // Подтверждение, что инструмент действительно выполнился: ответ содержит
      // profilesDir — временный путь, который модель не может сфабриковать.
      expect: (s) =>
        (s.transcript.includes('profilesDir') && s.transcript.includes('smoke')) ||
        `workflow-list не сообщил профиль smoke: ${s.transcript.slice(0, 300)}`,
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'workflow-list ran through the host and listed the project profiles'
        : `${result.detail}\n${result.session.transcript.slice(0, 600)}`,
    };
  },
};
