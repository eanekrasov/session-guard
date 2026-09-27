/** A live subagent closes a gate with its own workflow-result */

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
  title: 'A live subagent closes a gate with its own workflow-result',
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'verify-loop');
    let attempts = 0;

    for (const entry of [
      {
        instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
        expect: (s: Session) => s.state !== null || 'workflow-create did not run',
      },
      {
        instruction: CONSENT_INSTRUCTION,
        expect: (s: Session) =>
          stage(s) === 'tasks_ready' || `stage is ${stage(s)}, expected tasks_ready`,
      },
      {
        instruction:
          'Call the tool `workflow-tasks-set` with tasks ' +
          '[{"writeScope":["src/smoke-1.ts"],"status":"pending"}]. Do nothing else.',
        expect: (s: Session) => stage(s) === 'execution' || `stage is ${stage(s)}`,
      },
      {
        // The code stage: a real edit, so the invariants gate is earned.
        instruction:
          'Use the task tool with subagent_type "coder" and description ' +
          '"[workflow-task:task-0] write the file", telling it to create src/smoke-1.ts ' +
          'containing `export const smoke = 1;` and then finish with exactly ' +
          '<workflow-result>{"gate":"code","status":"pass","summary":"wrote the file",' +
          '"evidence":["src/smoke-1.ts"]}</workflow-result>',
        expect: (s: Session) => {
          // The stage moves on the coder's own <workflow-result>, so a model
          // that reports a pass without writing anything would move the task
          // just the same. `changedFiles` is the core's own record of what
          // landed on disk inside the task's writeScope, and it is what makes
          // this step about the work rather than about the report of it.
          const changed = (s.state as { changedFiles?: string[] } | null)?.changedFiles ?? [];
          if (!changed.includes('src/smoke-1.ts')) {
            return `the coder reported a pass but nothing was written (changedFiles: ${JSON.stringify(changed)})`;
          }
          const run = firstRun(s);
          return run?.stage === 'verify' || `the task is at ${run?.stage ?? '(no run)'}`;
        },
      },
      {
        // One of two verifiers reports. The stage must hold: it declared two.
        instruction:
          'Use the task tool with subagent_type "reviewer" and description ' +
          '"[workflow-task:task-0] review the file", telling it to review src/smoke-1.ts.',
        expect: (s: Session) => {
          const run = firstRun(s);
          if (run?.gates?.review !== 'passed') {
            return `the review gate is ${run?.gates?.review ?? '(unset)'}`;
          }
          return run.stage === 'verify' || 'the stage moved on a single verdict';
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
          return status === 'completed' || `the task is ${status ?? '(missing)'}`;
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
        'two live subagents each closed their own gate with a workflow-result; ' +
        'the stage held for the first and completed the task on the second',
    };
  },
};
