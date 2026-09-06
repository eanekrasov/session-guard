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
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
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
  const transcript = [
    reply.info?.error?.data?.message ?? '',
    ...parts.map((part) =>
      [
        part.text ?? '',
        part.state?.output ?? '',
        part.state?.error ?? '',
        part.tool ? `«tool:${part.tool}»` : '',
      ].join(' ')
    ),
  ].join('\n');

  return {
    id: sessionId,
    state: (await readWorkflowSession(host, sessionId)) as Record<string, unknown> | null,
    parts,
    transcript,
  };
}

/** Repeat an instruction until its expectation holds, or attempts run out. */
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
  /** Extra environment for this scenario's host. */
  env?: Record<string, string>;
  /** What the scenario proves, in the report. */
  run: (host: Host, model: string) => Promise<{ ok: boolean; evidence: string; attempts: number }>;
};

const ORCHESTRATOR = 'orchestrator';

function phase(session: Session): string {
  return String(session.state?.currentPhase ?? '(none)');
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
          const currentPhase = phase(s);
          return currentPhase === 'planning' || `phase is ${currentPhase}, expected planning`;
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? `session persisted in phase ${phase(result.session)}`
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
        instruction: 'Do this in two tool calls and nothing else. ' +
        'First call `workflow.consent` with files ["plan.md"] and summary "smoke plan". ' +
        'Then call the `question` tool once, passing as the question text the ENTIRE ' +
        '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
        'character for character, with options labelled "grant" and "decline".',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const refs = (s.state as { refs?: Record<string, string> } | null)?.refs ?? {};
          if (!refs.plan) return 'the plan reference was never recorded';
          const currentPhase = phase(s);
          return currentPhase === 'tasks_ready' || `phase is ${currentPhase}, expected tasks_ready`;
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
          return (
            /workflow-commit-rejected/.test(s.transcript) || 'the refusal never reached the agent'
          );
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
    id: 'machine-limit',
    title: 'The shipped base machine stops at review — no code path passes that gate',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'machine-limit');
      const prepared = await prepareCommittableSession(host, sessionId, model);
      if (!prepared.ok) return prepared;
      const state = (await readWorkflowSession(host, sessionId)) as {
        currentPhase?: string;
        gates?: Array<{ id: string; status: string }>;
      } | null;
      const gates = (state?.gates ?? []).map((gate) => `${gate.id}=${gate.status}`).join(', ');
      const stopped = state?.currentPhase === 'review';
      return {
        ok: stopped,
        attempts: prepared.attempts,
        evidence: stopped
          ? `the run reaches review and halts there (gates: ${gates}). ` +
            'FINDING: nothing in src ever sets the review or qa gate, so review → qa → commit → done ' +
            'is unreachable in the shipped machine.'
          : `expected the run to halt at review, it is at ${state?.currentPhase} (gates: ${gates})`,
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
      instruction: 'Do this in two tool calls and nothing else. ' +
        'First call `workflow.consent` with files ["plan.md"] and summary "smoke plan". ' +
        'Then call the `question` tool once, passing as the question text the ENTIRE ' +
        '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
        'character for character, with options labelled "grant" and "decline".',
      agent: ORCHESTRATOR,
      expect: (s) => phase(s) === 'tasks_ready' || `phase is ${phase(s)}, expected tasks_ready`,
    },
    {
      instruction:
        'Call the tool `workflow.tasks-set` with tasks ' +
        JSON.stringify(files.map((path) => ({ path, status: 'pending' }))) +
        '. Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => phase(s) === 'code' || `phase is ${phase(s)}, expected code`,
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

  for (const stage of stages) {
    const result = await step(host, sessionId, model, stage);
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
      profile: 'smoke',
      env: scenario.env,
      files: {
        'commit-task.ts': await Bun.file(join(import.meta.dir!, '../commit-task.ts')).text(),
        'plan.md': '# Smoke plan\n\nAdd one file under src/.\n',
      },
    });
    try {
      const outcome = await scenario.run(host, model);
      if (!outcome.ok && process.env.HOST_SMOKE_DEBUG) {
        const relevant = host
          .logs()
          .split('\n')
          .filter((line) => /state-machine|consent|Consent/i.test(line));
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
