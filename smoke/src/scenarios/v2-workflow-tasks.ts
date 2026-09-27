/** Список задач, заданный после consent, переводит сессию в свой цикл */

import { CONSENT_INSTRUCTION, ORCHESTRATOR, stage, type V2Scenario } from '../v2-scenario-kit.ts';

export const v2WorkflowTasks: V2Scenario = {
  id: 'v2-workflow-tasks',
  title: 'A task list set after consent moves the session into its loop',
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
        state.currentStage === 'tasks_ready' || `стадия — ${stage(state)}, ожидалась tasks_ready`,
    },
    {
      instruction:
        'Call the tool `workflow-tasks-set` with tasks ' +
        '[{"writeScope":["src/smoke-1.ts"],"status":"pending"}]. Do nothing else.',
      expect: (state) =>
        state.currentStage === 'execution' || `стадия — ${stage(state)}, ожидалась execution`,
    },
  ],
};
