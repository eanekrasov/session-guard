/** Живой субагент закрывает гейт собственным workflow-result */

import {
  CONSENT_INSTRUCTION,
  ORCHESTRATOR,
  firstRun,
  newSession,
  stage,
  step,
} from '../scenario-kit.ts';
import type { Scenario, Session } from '../scenario-kit.ts';

export const verifyLoop: Scenario = {
  id: 'verify-loop',
  title: 'Живой субагент закрывает гейт собственным workflow-result',
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'verify-loop');
    let attempts = 0;

    for (const entry of [
      {
        instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
        expect: (s: Session) => s.state !== null || 'workflow-create не выполнился',
      },
      {
        instruction: CONSENT_INSTRUCTION,
        expect: (s: Session) =>
          stage(s) === 'tasks_ready' || `стадия — ${stage(s)}, ожидалась tasks_ready`,
      },
      {
        instruction:
          'Call the tool `workflow-tasks-set` with tasks ' +
          '[{"writeScope":["src/smoke-1.ts"],"status":"pending"}]. Do nothing else.',
        expect: (s: Session) => stage(s) === 'execution' || `стадия — ${stage(s)}`,
      },
      {
        // Стадия code: настоящее редактирование, поэтому гейт инвариантов заработан.
        instruction:
          'Use the task tool with subagent_type "coder" and description ' +
          '"[workflow-task:task-0] write the file", telling it to create src/smoke-1.ts ' +
          'containing `export const smoke = 1;` and then finish with exactly ' +
          '<workflow-result>{"gate":"code","status":"pass","summary":"wrote the file",' +
          '"evidence":["src/smoke-1.ts"]}</workflow-result>',
        expect: (s: Session) => {
          // Стадия переходит по собственному <workflow-result> кодера, поэтому
          // модель, сообщившая об успехе без записи файлов, точно так же
          // перевела бы задачу. `changedFiles` — это собственная запись ядра
          // о том, что попало на диск в пределах writeScope задачи; именно
          // она делает этот шаг проверкой работы, а не отчёта о ней.
          const changed = (s.state as { changedFiles?: string[] } | null)?.changedFiles ?? [];
          if (!changed.includes('src/smoke-1.ts')) {
            return `coder сообщил об успехе, но ничего не записано (изменённые файлы: ${JSON.stringify(changed)})`;
          }
          const run = firstRun(s);
          return (
            run?.stage === 'verify' || `задача находится на стадии ${run?.stage ?? '(нет запуска)'}`
          );
        },
      },
      {
        // Один из двух верификаторов отчитывается. Стадия должна удерживаться: объявлено две.
        instruction:
          'Use the task tool with subagent_type "reviewer" and description ' +
          '"[workflow-task:task-0] review the file", telling it to review src/smoke-1.ts.',
        expect: (s: Session) => {
          const run = firstRun(s);
          if (run?.gates?.review !== 'passed') {
            return `гейт review имеет статус ${run?.gates?.review ?? '(не задан)'}`;
          }
          return run.stage === 'verify' || 'стадия перешла дальше по одному вердикту';
        },
      },
      {
        instruction:
          'Use the task tool with subagent_type "tester" and description ' +
          '"[workflow-task:task-0] verify the file", telling it to verify src/smoke-1.ts.',
        expect: (s: Session) => {
          const tasks = (s.state as { tasks?: Record<string, Array<{ status: string }>> } | null)
            ?.tasks;
          const status = tasks?.implementation?.[0]?.status;
          return status === 'completed' || `статус задачи: ${status ?? '(отсутствует)'}`;
        },
      },
    ]) {
      const result = await step(host, sessionId, model, { ...entry, agent: ORCHESTRATOR });
      attempts += result.attempts;
      if (!result.ok) {
        return {
          ok: false,
          attempts,
          evidence: `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
        };
      }
    }

    return {
      ok: true,
      attempts,
      evidence:
        'два живых субагента закрыли каждый свой гейт с помощью workflow-result; ' +
        'после первого вердикта стадия не сдвинулась, после второго задача завершилась',
    };
  },
};
