/** Настроенная модель вызывает workflow-create через клиент V2 */

import { ORCHESTRATOR, stage, type V2Scenario } from '../v2-scenario-kit.ts';

export const v2WorkflowCreate: V2Scenario = {
  id: 'v2-workflow-create',
  title: 'The configured model calls workflow-create through the V2 client',
  agent: ORCHESTRATOR,
  steps: [
    {
      instruction:
        'Call the tool `workflow-create` with schemaId "smoke". Do nothing else and add no commentary.',
      expect: (state) => state.currentStage === 'planning' || `workflow state was ${stage(state)}`,
    },
  ],
};
