/** Consent запрашивается как форма хоста, получает ответ и открывает переход */

import { CONSENT_INSTRUCTION, ORCHESTRATOR, stage, type V2Scenario } from '../v2-scenario-kit.ts';

export const v2WorkflowConsent: V2Scenario = {
  id: 'v2-workflow-consent',
  title: 'Consent is asked as a host form, answered, and releases the transition',
  agent: ORCHESTRATOR,
  steps: [
    {
      instruction:
        'Call the tool `workflow-create` with schemaId "smoke". Do nothing else and add no commentary.',
      expect: (state) => state.currentStage === 'planning' || `состояние workflow: ${stage(state)}`,
    },
    {
      instruction: CONSENT_INSTRUCTION,
      expect: (state) =>
        state.currentStage === 'tasks_ready' ||
        `стадия — ${stage(state)}, ожидалась tasks_ready после согласия`,
    },
  ],
};
