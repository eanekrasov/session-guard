/** Только orchestrator может записывать состояние workflow-задач */

import { ORCHESTRATOR, newSession, step } from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const taskControl: Scenario = {
  id: 'task-control',
  title: 'Только orchestrator может изменять состояние задач workflow',
  run: async (host, model) => {
    const sessionId = await newSession(host, 'task-control');
    await step(host, sessionId, model, {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create не выполнился',
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
          `orchestrator не смог задать список задач (сохранённые списки: ${JSON.stringify(tasks)})`
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
      // Агент по умолчанию — worker, а не orchestrator.
      expect: (s) => {
        const tasks = (s.state as { tasks?: Record<string, Array<{ status: string }>> } | null)
          ?.tasks;
        const status = tasks?.implementation?.[0]?.status;
        if (status === 'completed') return 'worker-агент закрыл собственную задачу';
        return /refus/i.test(s.transcript) || `отказ не обнаружен (статус остался ${status})`;
      },
    });
    return {
      ok: refused.ok,
      attempts: set.attempts + refused.attempts,
      evidence: refused.ok
        ? 'orchestrator задал список; worker-агент получил отказ, а статус остался pending'
        : `${refused.detail}\n${refused.session.transcript.slice(0, 800)}`,
    };
  },
};
