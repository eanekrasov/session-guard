#!/usr/bin/env bun
/**
 * host-smoke — drives the plugin through a real opencode.
 *
 * Every assertion here is made against what the host and the plugin actually
 * did: the session the plugin persisted, and the tool parts the host recorded.
 * Nothing calls into the plugin directly, so a scenario that passes here is
 * evidence the mechanism works in production, not that a unit test agrees with
 * itself.
 *
 * A live model drives the tools, so a step can fail because the model ignored
 * the instruction rather than because the plugin misbehaved. Each step is
 * therefore retried, and the report records how many attempts it took: a step
 * that needed retries is a prompt problem, a step that never succeeded is a
 * finding.
 *
 *   bun run scripts/host-smoke/run.ts              # every scenario
 *   bun run scripts/host-smoke/run.ts git-block    # one scenario by id
 *
 * Env: HOST_SMOKE_MODEL (default: the model in your opencode config),
 *      HOST_SMOKE_PLUGIN (skip build+pack, use this tarball),
 *      HOST_SMOKE_ATTEMPTS (default 3).
 */
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  api,
  buildPlugin,
  defaultModel,
  readWorkflowSession,
  startHost,
  type Host,
} from './harness.ts';

const ATTEMPTS = Number(process.env.HOST_SMOKE_ATTEMPTS ?? 3);

interface Part {
  type: string;
  tool?: string;
  text?: string;
  state?: { status?: string; error?: string; output?: string; input?: unknown };
}
interface Message {
  info: { role: string; error?: { data?: { message?: string } } };
  parts: Part[];
}

interface Session {
  id: string;
  state: Record<string, unknown> | null;
  /** Everything the assistant produced for the last prompt. */
  parts: Part[];
  /** Tool output and errors, flattened for matching. */
  transcript: string;
}

/**
 * Answer consent questions while a prompt is running.
 *
 * The host's `question` tool blocks until an operator replies, so the run would
 * hang otherwise. The harness plays the operator: it picks the option the
 * instruction asked for (default: grant), which is exactly the decision the
 * consent mechanism is there to record.
 */
function answerQuestions(host: Host, choose: 'grant' | 'decline'): { stop: () => void } {
  let stopped = false;
  const seen = new Set<string>();

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const pending = (await api(host, 'GET', '/question')) as Array<{
          id: string;
          questions?: Array<{ options?: Array<{ label?: string } | string> }>;
        }>;
        for (const request of pending ?? []) {
          if (seen.has(request.id)) continue;
          seen.add(request.id);
          if (process.env.HOST_SMOKE_DEBUG) {
            console.error(`  question: ${JSON.stringify(request).slice(0, 400)}`);
          }
          const answers = (request.questions ?? [{}]).map((question) => {
            const labels = (question.options ?? []).map((option) =>
              typeof option === 'string' ? option : (option.label ?? '')
            );
            const wanted = labels.find((label) => label.toLowerCase().includes(choose));
            return [wanted ?? labels[0] ?? choose];
          });
          await api(host, 'POST', `/question/${request.id}/reply`, { answers });
        }
      } catch {
        // The server is busy or gone; the prompt itself will report the failure.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  };
  void loop();
  return { stop: () => (stopped = true) };
}

const SESSION_LOG = join(import.meta.dirname!, '../../.memory/session.log');

/** Log the full `say` exchange: instruction sent, every part of the reply. */
async function logExchange(
  instruction: string,
  agent: string | undefined,
  error: string,
  parts: Part[]
): Promise<void> {
  const lines = [
    '',
    `─── ${new Date().toISOString()} ───`,
    `→ agent: ${agent ?? '(default)'}`,
    `→ instruction: ${instruction}`,
    ...(error ? [`⚠ error: ${error}`] : []),
    ...parts.map((p, i) => {
      const tool = p.tool ? ` [tool: ${p.tool}]` : '';
      const state = p.state
        ? ` [state: ${JSON.stringify(p.state).slice(0, 200)}]`
        : '';
      return `  [${i}]${tool}${state} ${(p.text ?? '').slice(0, 400)}`;
    }),
  ];
  await appendFile(SESSION_LOG, lines.join('\n'), 'utf-8').catch(() => {});
}

/** Send one instruction and return what the host recorded for it. */
async function say(
  host: Host,
  sessionId: string,
  model: string,
  text: string,
  agent?: string
): Promise<Session> {
  const [providerID, ...rest] = model.split('/');
  const operator = answerQuestions(host, 'grant');
  let reply: Message;
  try {
    reply = (await api(host, 'POST', `/session/${sessionId}/message`, {
      model: { providerID, modelID: rest.join('/') },
      ...(agent ? { agent } : {}),
      parts: [{ type: 'text', text }],
    })) as Message;
  } finally {
    operator.stop();
  }

  const parts = reply.parts ?? [];
  const error = reply.info?.error?.data?.message ?? '';
  const transcript = [
    error,
    ...parts.map((part) =>
      [
        part.text ?? '',
        part.state?.output ?? '',
        part.state?.error ?? '',
        part.tool ? `«tool:${part.tool}»` : '',
      ].join(' ')
    ),
  ].join('\n');

  await logExchange(text, agent, error, parts);

  return {
    id: sessionId,
    state: (await readWorkflowSession(host, sessionId)) as Record<string, unknown> | null,
    parts,
    transcript,
  };
}

/** Repeat an instruction until its expectation holds, or attempts run out. */
/** The last workflow session a step read, for diagnosing a failure. */
let lastState: unknown = null;

async function step(
  host: Host,
  sessionId: string,
  model: string,
  options: {
    instruction: string;
    agent?: string;
    expect: (session: Session) => boolean | string;
  }
): Promise<{ ok: boolean; attempts: number; detail: string; session: Session }> {
  let detail = '';
  let session!: Session;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    session = await say(host, sessionId, model, options.instruction, options.agent);
    lastState = session.state;
    const verdict = options.expect(session);
    if (verdict === true) return { ok: true, attempts: attempt, detail: '', session };
    detail = typeof verdict === 'string' ? verdict : 'expectation not met';
  }
  return { ok: false, attempts: ATTEMPTS, detail, session };
}

// ─── Scenario definitions ─────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  title: string;
  ok: boolean;
  evidence: string;
  attempts: number;
}

type Scenario = {
  id: string;
  title: string;
  /** Profile id to use (defaults to 'smoke'). */
  profile?: string;
  /** Extra environment for this scenario's host. */
  env?: Record<string, string>;
  /** What the scenario proves, in the report. */
  run: (host: Host, model: string) => Promise<{ ok: boolean; evidence: string; attempts: number }>;
};

const ORCHESTRATOR = 'orchestrator';

/** The consent step: prepare the tag, then ask the operator with it verbatim. */
const CONSENT_INSTRUCTION =
  'Do this in two tool calls and nothing else. ' +
  'First call `workflow.consent` with files ["plan.md"] and summary "smoke plan". ' +
  'Then call the `question` tool once, passing as the question text the ENTIRE ' +
  '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
  'character for character, with options labelled "grant" and "decline".';

interface RunView {
  stage?: string;
  status?: string;
  gates?: Record<string, string>;
}

/** The task run the loop is working, as the plugin persisted it. */
function firstRun(session: Session): RunView | undefined {
  const runs = (session.state as { loopRuns?: Record<string, RunView> } | null)?.loopRuns;
  return runs ? Object.values(runs)[0] : undefined;
}

function stage(session: Session): string {
  return String(session.state?.currentStage ?? '(none)');
}

async function newSession(host: Host, title: string): Promise<string> {
  const created = (await api(host, 'POST', '/session', { title })) as { id: string };
  return created.id;
}

const scenarios: Scenario[] = [
  {
    id: 'plugin-loads',
    title: 'The host loads the packed plugin and registers its tools',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'plugin-loads');
      const result = await step(host, sessionId, model, {
        instruction:
          'Call the tool `workflow.list` with no arguments, then reply with its output verbatim.',
        agent: ORCHESTRATOR,
        // Evidence the tool really ran: the reply carries the resolved
        // profilesDir, a temp path the model has no way to invent.
        expect: (s) =>
          (s.transcript.includes('profilesDir') && s.transcript.includes('smoke')) ||
          `workflow.list did not report the smoke profile: ${s.transcript.slice(0, 300)}`,
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'workflow.list ran through the host and listed the project profiles'
          : `${result.detail}\n${result.session.transcript.slice(0, 600)}`,
      };
    },
  },
  {
    id: 'no-session',
    title: 'Without a workflow session the plugin stays out of the way',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'no-session');
      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: git log --oneline -1. Do nothing else.',
        expect: (s) =>
          s.state === null || 'the plugin wrote a workflow session for an ungoverned session',
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'bash ran with no workflow session and the plugin persisted nothing'
          : result.detail,
      };
    },
  },
  {
    id: 'create',
    title: 'workflow.create puts the session under the state machine',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'create');
      const result = await step(host, sessionId, model, {
        instruction:
          'Call the tool `workflow.create` with schemaId "smoke". Do nothing else and add no commentary.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          if (!s.state) return 'no workflow session was persisted';
          const currentStage = stage(s);
          return currentStage === 'planning' || `stage is ${currentStage}, expected planning`;
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? `session persisted in stage ${stage(result.session)}`
          : `${result.detail}\n${result.session.transcript.slice(0, 600)}`,
      };
    },
  },
  {
    id: 'git-block',
    title: 'A bare git commit is refused inside a governed session',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'git-block');
      await step(host, sessionId, model, {
        instruction: 'Call the tool `workflow.create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow.create did not run',
      });
      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: git commit --allow-empty -m "smoke". ' +
          'Report what happened, verbatim.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const refused = /not allowed|refus|blocked|workflow/i.test(s.transcript);
          return refused || 'the commit was not refused';
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'the host cancelled the tool call and surfaced the workflow reason'
          : `${result.detail}\n${result.session.transcript.slice(0, 800)}`,
      };
    },
  },
  {
    id: 'task-control',
    title: 'Only the orchestrator may write workflow task state',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'task-control');
      await step(host, sessionId, model, {
        instruction: 'Call the tool `workflow.create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow.create did not run',
      });
      const set = await step(host, sessionId, model, {
        instruction:
          'Call the tool `workflow.tasks-set` with tasks ' +
          '[{"path":"src/a.ts","status":"pending"}]. Do nothing else.',
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
          'Call the tool `workflow.tasks-set-status` with taskId "task-1" and status "completed". ' +
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
  },
  {
    id: 'commit-gate',
    title: 'commit-task is refused while the gates have not passed',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'commit-gate');
      await step(host, sessionId, model, {
        instruction: 'Call the tool `workflow.create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow.create did not run',
      });
      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: too early". ' +
          'Report what happened, verbatim.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const receipt = (s.state as { deliveryReceipt?: string | null } | null)?.deliveryReceipt;
          if (receipt) return 'a delivery receipt was written before the gates passed';
          return (
            /cannot commit|refus|not allowed/i.test(s.transcript) || 'no refusal surfaced'
          );
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'canCommit refused the call and no receipt was written'
          : `${result.detail}\n${result.session.transcript.slice(0, 800)}`,
      };
    },
  },
  {
    id: 'plan-consent',
    title: 'An approved plan moves the session out of planning',
    // The operator normally answers the consent question. `HARNESS_AUTO_APPROVE`
    // is the shipped affordance for automation; the refusal side is covered by
    // `commit-gate`, which runs without it.
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'plan-consent');
      await step(host, sessionId, model, {
        instruction: 'Call the tool `workflow.create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow.create did not run',
      });
      const result = await step(host, sessionId, model, {
        instruction: CONSENT_INSTRUCTION,
        agent: ORCHESTRATOR,
        expect: (s) => {
          const refs = (s.state as { refs?: Record<string, string> } | null)?.refs ?? {};
          if (!refs.plan) return 'the plan reference was never recorded';
          const currentStage = stage(s);
          return currentStage === 'tasks_ready' || `stage is ${currentStage}, expected tasks_ready`;
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'consent recorded the plan reference and the guard released planning → tasks_ready'
          : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
      };
    },
  },
  {
    id: 'commit-receipt',
    title: 'A commit that matches the permit is receipted',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'commit-receipt');
      const prepared = await prepareCommittableSession(host, sessionId, model);
      if (!prepared.ok) return prepared;

      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: deliver". ' +
          'Report the output verbatim.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const receipt = (s.state as { deliveryReceipt?: string | null } | null)?.deliveryReceipt;
          if (!receipt) return `no delivery receipt was written: ${s.transcript.slice(0, 300)}`;
          const head = headOf(host);
          return receipt === head || `receipt ${receipt} does not match HEAD ${head}`;
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'the permit was issued, the commit moved HEAD, and the receipt records that commit'
          : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
      };
    },
  },
  {
    id: 'commit-mismatch',
    title: 'A commit that sweeps in an unrelated file is not receipted',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'commit-mismatch');
      const prepared = await prepareCommittableSession(host, sessionId, model);
      if (!prepared.ok) return prepared;

      // A file the workflow never saw. `commit-task.ts` stages everything, so
      // the commit will carry more than the permit expects.
      await writeFile(join(host.workDir, 'unrelated.txt'), 'not part of the work\n', 'utf-8');
      const before = headOf(host);

      // `commit-task` is not idempotent, so a retry of this step commits
      // nothing and says so. The proof lives in the session, not in whichever
      // attempt's transcript: HEAD moved, and no receipt was written for it.
      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: sweep". ' +
          'Report the output verbatim.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const state = s.state as {
            deliveryReceipt?: string | null;
            deliveryPermit?: unknown;
          } | null;
          if (state?.deliveryReceipt) return 'a commit of unrelated files was receipted';
          if (state?.deliveryPermit) return 'the stale permit was left in place';
          if (headOf(host) === before) return 'the commit never happened, so nothing was tested';
          return true;
        },
      });
      return {
        ok: result.ok,
        attempts: prepared.attempts + result.attempts,
        evidence: result.ok
          ? 'HEAD moved but the commit carried unrelated.txt: no receipt, permit dropped, refusal surfaced'
          : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
      };
    },
  },
  {
    id: 'comprehensive-full-cycle',
    title:
      'Full cycle through the comprehensive profile — entryGuards, exitGuards, gates, fail/retry, alternative transitions, commit receipt',
    profile: 'comprehensive',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'comprehensive-full-cycle');
      let attempts = 0;

      for (const entry of [
        {
          instruction:
            'Call the tool `workflow.create` with schemaId "comprehensive". Do nothing else.',
          expect: (s: Session) => s.state !== null || 'workflow.create did not run',
        },
        {
          instruction: CONSENT_INSTRUCTION,
          expect: (s: Session) =>
            stage(s) === 'tasks_ready' || `stage is ${stage(s)}, expected tasks_ready`,
        },
        {
          instruction:
            'Call the tool `workflow.tasks-set` with tasks ' +
            '[{"path":"src/comprehensive-1.ts","status":"pending"}]. Do nothing else.',
          expect: (s: Session) => stage(s) === 'execution' || `stage is ${stage(s)}`,
        },
        {
          // Сначала orchestrator пишет файл сам — это триггерит invariants в
          // родительской сессии. После этого task может перейти из code в verify.
          instruction:
            'First, use the write tool to create src/comprehensive-1.ts ' +
            'with content `export const comprehensive = 1;\n`. ' +
            'Then use the task tool with subagent_type "coder" and description ' +
            '"[workflow-task:task-0] confirm the file was written", telling it ' +
            'to read and confirm src/comprehensive-1.ts, and finish with exactly ' +
            '<workflow-result>{"stage":"code","status":"pass","summary":"confirmed the file","evidence":["src/comprehensive-1.ts"]}</workflow-result>',
          expect: (s: Session) => {
            const run = firstRun(s);
            return run?.stage === 'verify' || `the task is at ${run?.stage ?? '(no run)'}`;
          },
        },
        {
          instruction:
            'Use the task tool with subagent_type "reviewer" and description ' +
            '"[workflow-task:task-0] review the file", telling it to review ' +
            'src/comprehensive-1.ts and then finish with exactly ' +
            '<workflow-result>{"stage":"review","status":"pass","summary":"reviewed the file","evidence":["src/comprehensive-1.ts"]}</workflow-result>',
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
            '"[workflow-task:task-0] verify the file", telling it to verify ' +
            'src/comprehensive-1.ts and then finish with exactly ' +
            '<workflow-result>{"stage":"qa","status":"pass","summary":"verified the file","evidence":["src/comprehensive-1.ts"]}</workflow-result>',
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

      // Task completed → execution → validation → commit → done
      const commitResult = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly: bun run commit-task.ts -m "comprehensive: deliver". ' +
          'Report the output verbatim.',
        agent: ORCHESTRATOR,
        expect: (s: Session) => {
          const receipt = (s.state as { deliveryReceipt?: string | null } | null)?.deliveryReceipt;
          if (!receipt) return `no delivery receipt was written: ${s.transcript.slice(0, 300)}`;
          const head = headOf(host);
          return receipt === head || `receipt ${receipt} does not match HEAD ${head}`;
        },
      });
      attempts += commitResult.attempts;

      return {
        ok: commitResult.ok,
        attempts,
        evidence: commitResult.ok
          ? 'full cycle passed: entryGuards → write invariants → coder → exitGuards → gates review/qa → retry effect → execution→validation→commit→done'
          : `${commitResult.detail}\n${commitResult.session.transcript.slice(0, 700)}`,
      };
    },
  },
  {
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
          instruction:
            'Call the tool `workflow.create` with schemaId "cicd". Do nothing else.',
          expect: (s: Session) => s.state !== null || 'workflow.create did not run',
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
            '<workflow-result>{"stage":"checkout_done","status":"pass","summary":"created source file","evidence":["src/ci-demo.ts"]}</workflow-result>',
          expect: (s: Session) => {
            const gates = (s.state as { gates?: Array<{ id: string; status: string }> } | null)
              ?.gates ?? [];
            const checkout = gates.find((g) => g.id === 'checkout_done');
            return checkout?.status === 'passed' || `checkout_done gate is ${checkout?.status ?? '(unset)'}`;
          },
        },
        {
          instruction:
            'Use the task tool with subagent_type "builder" and description ' +
            '"[workflow-task:build] build the project", telling it to verify ' +
            'src/ci-demo.ts compiles correctly and then finish with exactly ' +
            '<workflow-result>{"stage":"build_done","status":"pass","summary":"build successful","evidence":["src/ci-demo.ts"]}</workflow-result>',
          expect: (s: Session) => stage(s) === 'test' || `stage is ${stage(s)}, expected test`,
        },
        {
          instruction:
            'Use the task tool with subagent_type "tester" and description ' +
            '"[workflow-task:task-0] unit test", telling it to run unit tests on ' +
            'src/ci-demo.ts and then finish with exactly ' +
            '<workflow-result>{"stage":"unit","status":"pass","summary":"unit tests passed","evidence":["src/ci-demo.ts"]}</workflow-result>',
          expect: (s: Session) => {
            const run = firstRun(s);
            return run?.gates?.unit === 'passed' || `unit gate is ${run?.gates?.unit ?? '(unset)'}`;
          },
        },
        {
          instruction:
            'Use the task tool with subagent_type "tester" and description ' +
            '"[workflow-task:task-1] integration test", telling it to verify ' +
            'src/ci-demo.ts works with the environment and then finish with exactly ' +
            '<workflow-result>{"stage":"integration","status":"pass","summary":"integration tests passed","evidence":["src/ci-demo.ts"]}</workflow-result>',
          expect: (s: Session) => {
            const tasks = (s.state as { tasks?: Record<string, Array<{ status: string }>> } | null)
              ?.tasks;
            const status = tasks?.test_suite?.[1]?.status;
            return status === 'completed' || `integration task is ${status ?? '(no run)'}`;
          },
        },
        {
          instruction:
            'Use the task tool with subagent_type "deployer" and description ' +
            '"[workflow-task:deploy] deploy the build", telling it to register the ' +
            'deployment of version 1.0.0 and then finish with exactly ' +
            '<workflow-result>{"stage":"deploy_done","status":"pass","summary":"deploy successful","evidence":["version=1.0.0"]}</workflow-result>',
          expect: (s: Session) => stage(s) === 'smoke' || `stage is ${stage(s)}, expected smoke`,
        },
        {
          instruction:
            'Use the task tool with subagent_type "smoke" and description ' +
            '"[workflow-task:smoke] smoke test deployment", telling it to verify the ' +
            'deployment and then finish with exactly ' +
            '<workflow-result>{"stage":"smoke","status":"pass","summary":"smoke tests passed","evidence":["deployment-ok"]}</workflow-result>',
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
  },
  {
    id: 'verify-loop',
    title: 'A live subagent closes a gate with its own workflow-result',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'verify-loop');
      let attempts = 0;

      for (const entry of [
        {
          instruction: 'Call the tool `workflow.create` with schemaId "smoke". Do nothing else.',
          expect: (s: Session) => s.state !== null || 'workflow.create did not run',
        },
        {
          instruction: CONSENT_INSTRUCTION,
          expect: (s: Session) =>
            stage(s) === 'tasks_ready' || `stage is ${stage(s)}, expected tasks_ready`,
        },
        {
          instruction:
            'Call the tool `workflow.tasks-set` with tasks ' +
            '[{"path":"src/smoke-1.ts","status":"pending"}]. Do nothing else.',
          expect: (s: Session) => stage(s) === 'execution' || `stage is ${stage(s)}`,
        },
        {
          // The code stage: a real edit, so the invariants gate is earned.
          instruction:
            'Use the task tool with subagent_type "coder" and description ' +
            '"[workflow-task:task-0] write the file", telling it to create src/smoke-1.ts ' +
            'containing `export const smoke = 1;` and then finish with exactly ' +
            '<workflow-result>{"stage":"code","status":"pass","summary":"wrote the file",' +
            '"evidence":["src/smoke-1.ts"]}</workflow-result>',
          expect: (s: Session) => {
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
  },
];

/**
 * Drive a session to the point where a commit is legitimate: plan approved,
 * tasks set and completed, invariants passed by a real mutation.
 */
async function prepareCommittableSession(
  host: Host,
  sessionId: string,
  model: string,
  fileCount = 1
): Promise<{ ok: boolean; evidence: string; attempts: number }> {
  let attempts = 0;
  const files = Array.from({ length: fileCount }, (_, index) => `src/smoke-${index + 1}.ts`);

  const stages: Array<{ instruction: string; agent?: string; expect: (s: Session) => boolean | string }> = [
    {
      instruction: 'Call the tool `workflow.create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow.create did not run',
    },
    {
      instruction: CONSENT_INSTRUCTION,
      agent: ORCHESTRATOR,
      expect: (s) => stage(s) === 'tasks_ready' || `stage is ${stage(s)}, expected tasks_ready`,
    },
    {
      instruction:
        'Call the tool `workflow.tasks-set` with tasks ' +
        JSON.stringify(files.map((path) => ({ path, status: 'pending' }))) +
        '. Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => stage(s) === 'execution' || `stage is ${stage(s)}, expected execution`,
    },
    {
      instruction:
        'Use the write tool to create each of these files with the content ' +
        '"export const smoke = 1;\n": ' +
        files.join(', ') +
        '. Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        const gates = (s.state as { gates?: Array<{ id: string; status: string }> } | null)?.gates;
        const invariants = gates?.find((gate) => gate.id === 'invariants')?.status;
        return invariants === 'passed' || `invariants gate is ${invariants}`;
      },
    },
    ...files.map((_, index) => ({
      instruction:
        `Call the tool \`workflow.tasks-set-status\` with taskId "task-${index}" and status "completed". ` +
        'Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s: Session) => {
        const tasks = (s.state as { tasks?: Record<string, Array<{ status: string }>> } | null)
          ?.tasks;
        const list = tasks?.implementation ?? [];
        return (
          list[index]?.status === 'completed' ||
          `task-${index} is ${list[index]?.status ?? '(missing)'}`
        );
      },
    })),
  ];

  for (const entry of stages) {
    const result = await step(host, sessionId, model, entry);
    attempts += result.attempts;
    if (!result.ok) {
      return {
        ok: false,
        attempts,
        evidence: `${result.detail}\n${result.session.transcript.slice(0, 600)}`,
      };
    }
  }
  return { ok: true, attempts, evidence: '' };
}

/** Current HEAD of the throwaway project. */
function headOf(host: Host): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: host.workDir,
    encoding: 'utf-8',
  });
  return (result.stdout ?? '').trim();
}


// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const selected = wanted.length
    ? scenarios.filter((scenario) => wanted.includes(scenario.id))
    : scenarios;
  if (selected.length === 0) {
    console.error(`No such scenario. Known: ${scenarios.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }

  const model = await defaultModel();
  const plugin = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
  process.env.HOST_SMOKE_PLUGIN = plugin;

  console.error(`model:  ${model}`);
  console.error(`plugin: ${plugin}\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    process.stderr.write(`▶ ${scenario.id} … `);
    const host = await startHost({
      model,
      profile: scenario.profile ?? 'smoke',
      env: scenario.env,
      files: {
        'commit-task.ts': await Bun.file(join(import.meta.dir!, '../commit-task.ts')).text(),
        'plan.md': '# Smoke plan\n\nAdd one file under src/.\n',
      },
    });
    try {
      const outcome = await scenario.run(host, model);
      if (!outcome.ok && process.env.HOST_SMOKE_DEBUG) {
        console.error(`  state: ${JSON.stringify(lastState).slice(0, 1200)}`);
        const relevant = host
          .logs()
          .split('\n')
          .filter((line) => /state-machine|consent|DIAG|workflow/i.test(line));
        console.error(`  host log:\n    ${relevant.slice(-25).join('\n    ')}`);
      }
      results.push({ id: scenario.id, title: scenario.title, ...outcome });
      console.error(outcome.ok ? `PASS (${outcome.attempts} attempt(s))` : 'FAIL');
      if (!outcome.ok) console.error(`  ${outcome.evidence.split('\n').join('\n  ')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        title: scenario.title,
        ok: false,
        attempts: 0,
        evidence: `harness error: ${message}\n${host.logs().slice(-1500)}`,
      });
      console.error('ERROR');
      console.error(`  ${message}`);
      if (process.env.HOST_SMOKE_DEBUG) console.error(host.logs().slice(-4000));
    } finally {
      await host.stop();
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const report = [
    '# Host smoke — session-guard against a real opencode',
    '',
    `| Model | \`${model}\` |`,
    '|---|---|',
    `| Plugin | \`${plugin.split('/').at(-1)}\` |`,
    `| Result | ${passed}/${results.length} scenarios passed |`,
    '',
    '| # | Scenario | Result | Attempts | Evidence |',
    '|---|---|---|---|---|',
    ...results.map(
      (result, index) =>
        `| ${index + 1} | ${result.title} | ${result.ok ? '**PASS**' : '**FAIL**'} | ${
          result.attempts
        } | ${result.evidence.replace(/\n/g, ' ').slice(0, 300)} |`
    ),
    '',
  ].join('\n');

  const reportPath = join(import.meta.dir!, '../../docs/host-smoke.md');
  await writeFile(reportPath, report, 'utf-8');
  console.error(`\n${passed}/${results.length} passed — report written to ${reportPath}`);
  process.exit(passed === results.length ? 0 : 1);
}

await main();
