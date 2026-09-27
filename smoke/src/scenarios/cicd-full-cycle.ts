/** Полный CI/CD-пайплайн: init → checkout → build → test(unit+integration) → deploy → smoke → done */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSENT_INSTRUCTION,
  ORCHESTRATOR,
  consentInstruction,
  firstRun,
  newSession,
  stage,
  step,
} from '../scenario-kit.ts';
import type { Scenario, Session } from '../scenario-kit.ts';

export const cicdFullCycle: Scenario = {
  id: 'cicd-full-cycle',
  title:
    'Full CI/CD pipeline: init → checkout → build → test(unit+integration) → deploy → smoke → done',
  profile: 'cicd',
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'cicd-full-cycle');
    let attempts = 0;

    for (const entry of [
      {
        instruction: 'Call the tool `workflow-create` with schemaId "cicd". Do nothing else.',
        expect: (s: Session) => s.state !== null || 'workflow-create did not run',
      },
      {
        instruction: CONSENT_INSTRUCTION,
        expect: (s: Session) =>
          stage(s) === 'checkout' || `stage is ${stage(s)}, expected checkout`,
      },
      {
        instruction:
          'Use the task tool with subagent_type "setup" and description ' +
          '"[workflow-task:checkout] prepare the project", telling it to create ' +
          'src/ci-demo.ts containing `export const appVersion = "1.0.0";` ' +
          'and then finish with exactly ' +
          '<workflow-result>{"gate":"checkout_done","status":"pass","summary":"created source file","evidence":["src/ci-demo.ts"]}</workflow-result>',
        expect: (s: Session) => {
          // Сначала файл, затем гейт. Раньше setup-агент, закрывающий
          // `checkout_done` без записи файла, проходил эту проверку,
          // и ошибка всплывала двумя шагами позже, когда build-агент
          // просил оператора создать недостающий файл — цикл,
          // переживший тайм-аут клиента и не сообщивший ничего.
          if (!existsSync(join(host.workDir, 'src', 'ci-demo.ts'))) {
            return 'setup reported a pass but src/ci-demo.ts was never created';
          }
          const gates =
            (s.state as { stageGateResults?: Array<{ id: string; status: string }> } | null)
              ?.stageGateResults ?? [];
          const checkout = gates.find((g) => g.id === 'checkout_done');
          return (
            checkout?.status === 'passed' ||
            `checkout_done gate is ${checkout?.status ?? '(unset)'}`
          );
        },
      },
      {
        instruction:
          'Use the task tool with subagent_type "builder" and description ' +
          '"[workflow-task:build] build the project", telling it to verify ' +
          'src/ci-demo.ts compiles correctly and then finish with exactly ' +
          '<workflow-result>{"gate":"build_done","status":"pass","summary":"build successful","evidence":["src/ci-demo.ts"]}</workflow-result>',
        expect: (s: Session) => stage(s) === 'test' || `stage is ${stage(s)}, expected test`,
      },
      {
        // `test` — это цикл по `test_suite`, а цикл без задач не
        // диспетчеризирует ничего: каждый вызов `[workflow-task:...]`
        // был отклонён, модель продолжала попытки, и один промпт
        // пережил тайм-аут клиента. Именно это сценарий и сообщил
        // как ошибку.
        //
        // Без `writeScope`: тестировщик сообщает, а не записывает;
        // отсутствие области видимости — это именно «только чтение»
        // (session-schema.ts).
        instruction:
          'Call the tool `workflow-tasks-set` with listKey "test_suite" and tasks ' +
          '[{"status":"pending"}]. Do nothing else.',
        expect: (s: Session) => {
          const tasks = (s.state as { tasks?: Record<string, unknown[]> } | null)?.tasks ?? {};
          return (
            (tasks.test_suite ?? []).length === 1 ||
            `the test_suite list is ${JSON.stringify(tasks.test_suite ?? [])}`
          );
        },
      },
      {
        // Одна задача проходит обе вложенные стадии — unit, затем integration.
        // У цикла нет собственных переходов, поэтому порядок объявления
        // двигает задачу, а последняя стадия завершает её. Две отдельные
        // задачи работать не могут: каждая задача начинается с первой
        // вложенной стадии, поэтому результат с именем `integration`
        // пришёл бы на стадию `unit`, которая не объявляет такого гейта,
        // и был бы отклонён.
        instruction:
          'Use the task tool with subagent_type "tester" and description ' +
          '"[workflow-task:task-0] unit test", telling it to run unit tests on ' +
          'src/ci-demo.ts and then finish with exactly ' +
          '<workflow-result>{"gate":"unit","status":"pass","summary":"unit tests passed","evidence":["src/ci-demo.ts"]}</workflow-result>',
        expect: (s: Session) => {
          // Вердикт перемещает задачу, а перемещение очищает гейты,
          // по которым выносилось суждение — каждая стадия судит свою
          // работу. Поэтому доказательство того, что `unit` пройдена, —
          // это текущее положение задачи, а не значение гейта.
          const run = firstRun(s);
          return run?.stage === 'integration' || `the task is at ${run?.stage ?? '(no run)'}`;
        },
      },
      {
        instruction:
          'Use the task tool with subagent_type "tester" and description ' +
          '"[workflow-task:task-0] integration test", telling it to verify ' +
          'src/ci-demo.ts works with the environment and then finish with exactly ' +
          '<workflow-result>{"gate":"integration","status":"pass","summary":"integration tests passed","evidence":["src/ci-demo.ts"]}</workflow-result>',
        expect: (s: Session) => {
          const tasks = (s.state as { tasks?: Record<string, Array<{ status: string }>> } | null)
            ?.tasks;
          const status = tasks?.test_suite?.[0]?.status;
          return status === 'completed' || `the test task is ${status ?? '(missing)'}`;
        },
      },
      {
        instruction:
          'Use the task tool with subagent_type "deployer" and description ' +
          '"[workflow-task:deploy] deploy the build", telling it to register the ' +
          'deployment of version 1.0.0 and then finish with exactly ' +
          '<workflow-result>{"gate":"deploy_done","status":"pass","summary":"deploy successful","evidence":["version=1.0.0"]}</workflow-result>',
        expect: (s: Session) => {
          const gates =
            (s.state as { stageGateResults?: Array<{ id: string; status: string }> } | null)
              ?.stageGateResults ?? [];
          const deployed = gates.find((gate) => gate.id === 'deploy_done')?.status;
          return deployed === 'passed' || `deploy_done gate is ${deployed ?? '(unset)'}`;
        },
      },
      {
        // Ребро `deploy → smoke` объявляет `consent: deploy`. Раньше ядро
        // вообще не умело выдавать согласие с именем, отличным от `plan` —
        // переход был закрыт навсегда, и сценарий падал здесь с
        // «stage is deploy».
        instruction: consentInstruction('deploy'),
        expect: (s: Session) => {
          const approvals =
            (s.state as { approvals?: Array<{ type: string; status: string }> } | null)
              ?.approvals ?? [];
          const granted = approvals.some(
            (approval) => approval.type === 'deploy' && approval.status === 'granted'
          );
          if (!granted) return 'the deploy consent was never granted';
          return stage(s) === 'smoke' || `stage is ${stage(s)}, expected smoke`;
        },
      },
      {
        instruction:
          'Use the task tool with subagent_type "smoke" and description ' +
          '"[workflow-task:smoke] smoke test deployment", telling it to verify the ' +
          'deployment and then finish with exactly ' +
          '<workflow-result>{"gate":"smoke_result","status":"pass","summary":"smoke tests passed","evidence":["deployment-ok"]}</workflow-result>',
        expect: (s: Session) => stage(s) === 'done' || `stage is ${stage(s)}, expected done`,
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
        'full CI/CD pipeline passed: init → consent → setup → build → unit → integration → deploy (consent) → smoke → done',
    };
  },
};
