/** Full CI/CD pipeline: init → checkout → build → test(unit+integration) → deploy → smoke → done */

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
          // The file first, then the gate. A setup agent that closes
          // `checkout_done` without writing anything used to be accepted
          // here, and the failure surfaced two steps later as the build
          // agent asking the operator to create the missing file — a loop
          // that outlived the client's timeout and reported nothing at all.
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
        // `test` is a loop over `test_suite`, and a loop with no tasks
        // dispatches nothing: every `[workflow-task:...]` call was refused,
        // the model kept trying, and one prompt outlived the client's
        // timeout. That is what the scenario reported as an error.
        //
        // No `writeScope`: a tester reports, it does not write, and an
        // absent scope is exactly "read-only" (session-schema.ts).
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
        // One task walks both nested stages — unit, then integration. The
        // loop has no transitions of its own, so declaration order moves it,
        // and the last stage completes it. Two separate tasks cannot work:
        // every task starts at the first nested stage, so a result naming
        // `integration` would arrive at `unit`, which does not declare that
        // gate, and be rejected.
        instruction:
          'Use the task tool with subagent_type "tester" and description ' +
          '"[workflow-task:task-0] unit test", telling it to run unit tests on ' +
          'src/ci-demo.ts and then finish with exactly ' +
          '<workflow-result>{"gate":"unit","status":"pass","summary":"unit tests passed","evidence":["src/ci-demo.ts"]}</workflow-result>',
        expect: (s: Session) => {
          // The verdict moves the task, and a move clears the gates it was
          // judged by — each stage judges its own work. So the evidence that
          // `unit` passed is where the task now stands, not a gate value.
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
        // Ребро `deploy → smoke` объявляет `consent: deploy`. Согласие с
        // именем, отличным от `plan`, ядро выдавать не умело вовсе — переход
        // был закрыт навсегда, и сценарий падал здесь с «stage is deploy».
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
