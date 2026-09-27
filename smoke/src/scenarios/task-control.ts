/** Only the orchestrator may write workflow task state */

import { ORCHESTRATOR, newSession, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const taskControl: Scenario = {
  id: 'task-control',
  title: 'Only the orchestrator may write workflow task state',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'task-control');
    await step(host, sessionId, model, {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create did not run',
    });
    const set = await step(host, sessionId, model, {
      instruction:
        'Call the tool `workflow-tasks-set` with tasks ' +
        '[{"writeScope":["src/a.ts"],"status":"pending"}]. Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        const tasks = (s.state as { tasks?: Record<string, unknown[]> } | null)?.tasks ?? {};
        const list = tasks.implementation ?? [];
        return (
          list.length === 1 ||
          `the orchestrator could not set the task list (persisted lists: ${JSON.stringify(tasks)})`
        );
      },
    });
    if (!set.ok) {
      return {
        ok: false,
        attempts: set.attempts,
        evidence: `${set.detail}\n${set.session.transcript.slice(0, 900)}`,
      };
    }
    const refused = await step(host, sessionId, model, {
      instruction:
        'Call the tool `workflow-tasks-set-status` with taskId "task-1" and status "completed". ' +
        'Report the tool output verbatim.',
      // The default agent is a worker, not the orchestrator.
      expect: (s) => {
        const tasks = (s.state as { tasks?: Record<string, Array<{ status: string }>> } | null)
          ?.tasks;
        const status = tasks?.implementation?.[0]?.status;
        if (status === 'completed') return 'a worker agent closed its own task';
        return /refus/i.test(s.transcript) || `no refusal surfaced (status stayed ${status})`;
      },
    });
    return {
      ok: refused.ok,
      attempts: set.attempts + refused.attempts,
      evidence: refused.ok
        ? 'the orchestrator set the list; the worker agent was refused and the status stayed pending'
        : `${refused.detail}\n${refused.session.transcript.slice(0, 800)}`,
    };
  },
};
