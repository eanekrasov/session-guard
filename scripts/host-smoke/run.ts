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
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { api, defaultModel, packPlugin, readWorkflowSession, startHost, type Host } from './harness.ts';

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

/** Send one instruction and return what the host recorded for it. */
async function say(
  host: Host,
  sessionId: string,
  model: string,
  text: string,
  agent?: string
): Promise<Session> {
  const [providerID, ...rest] = model.split('/');
  const reply = (await api(host, 'POST', `/session/${sessionId}/message`, {
    model: { providerID, modelID: rest.join('/') },
    ...(agent ? { agent } : {}),
    parts: [{ type: 'text', text }],
  })) as Message;

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
          'Call the tool `workflow.list` with no arguments. Do nothing else and add no commentary.',
        agent: ORCHESTRATOR,
        expect: (s) =>
          s.transcript.includes('smoke') || 'workflow.list never reported the smoke profile',
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
          const tasks = (s.state as { tasks?: Record<string, unknown[]> } | null)?.tasks;
          const list = tasks?.implementation ?? [];
          return list.length === 1 || 'the orchestrator could not set the task list';
        },
      });
      if (!set.ok) {
        return { ok: false, attempts: set.attempts, evidence: set.detail };
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
];

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
  const plugin = process.env.HOST_SMOKE_PLUGIN ?? packPlugin();
  process.env.HOST_SMOKE_PLUGIN = plugin;

  console.error(`model:  ${model}`);
  console.error(`plugin: ${plugin}\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    process.stderr.write(`▶ ${scenario.id} … `);
    const host = await startHost({
      model,
      profile: 'smoke',
      files: {
        'commit-task.ts': await Bun.file(join(import.meta.dir!, '../commit-task.ts')).text(),
      },
    });
    try {
      const outcome = await scenario.run(host, model);
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
