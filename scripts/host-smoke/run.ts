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
import { existsSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  api,
  buildPlugin,
  defaultModel,
  hostVersionFromEnv,
  isTraceEnabled,
  log as harnessLog,
  opencodeBinary,
  readWorkflowSession,
  sanitizeTracePayload,
  startHost,
  stopAllHosts,
  type Host,
} from './harness.ts';

const ATTEMPTS = Number(process.env.HOST_SMOKE_ATTEMPTS ?? 3);
const OUTPUT_FORMAT = process.env.HOST_SMOKE_OUTPUT ?? 'human';

let shutdownPromise: Promise<void> | undefined;

function installSignalHandlers(): void {
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      if (shutdownPromise) return;
      shutdownPromise = (async () => {
        await stopAllHosts();
        process.exit(exitCode);
      })();
    });
  }
}

const ANSI = {
  reset: '\u001b[0m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  green: '\u001b[32m',
  magenta: '\u001b[35m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
} as const;

type LogColor = keyof Omit<typeof ANSI, 'reset'>;

function colorize(text: string, color: LogColor): string {
  const enabled =
    process.env.NO_COLOR === undefined &&
    (Boolean(process.env.FORCE_COLOR) || process.stderr.isTTY);
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

/** Write one complete event so concurrent question polling cannot split it. */
function logEvent(
  text: string,
  color?: LogColor,
  type = 'message',
  fields: Record<string, unknown> = {}
): void {
  if (OUTPUT_FORMAT === 'jsonl') {
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), type, message: text, ...fields })}\n`
    );
    return;
  }
  process.stderr.write(`${color ? colorize(text, color) : text}\n`);
}

function logBlock(label: string, text: string, color: LogColor, type: string): void {
  if (OUTPUT_FORMAT === 'jsonl') {
    logEvent(text, undefined, type, { label: label.trim() });
    return;
  }
  logEvent(`${colorize(label, color)}\n${text}`);
}

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
 * Words an option uses to say "no". Ordered: the earlier one wins, so an
 * explicit refusal beats a merely negative-sounding label.
 */
const DECLINING_WORDS = ['decline', 'no,', 'no ', 'cancel', 'stop', 'skip', "don't", 'do not'];

/** Questions the plugin raised carry its consent tag; anything else is the model's own. */
function isConsentQuestion(request: { questions?: Array<{ question?: string }> }): boolean {
  return (request.questions ?? []).some((entry) =>
    (entry?.question ?? '').includes('<consent-request')
  );
}

/**
 * Answer the host's questions while a prompt is running.
 *
 * The host's `question` tool blocks until an operator replies, so the run would
 * hang otherwise. The harness plays the operator, and an operator answers two
 * quite different things.
 *
 * A **consent request** is the scenario's own subject: it gets the decision the
 * instruction asked for (default: grant), which is exactly what the consent
 * mechanism exists to record.
 *
 * Anything else is a question the model invented — «How would you like to
 * proceed?» — and the harness used to answer it with the FIRST option, which is
 * almost always some flavour of «yes, go ahead». So an unscripted question
 * became permission to run past the scenario: `cicd-full-cycle` reached `test`
 * while the next step still expected `checkout`, and the failure blamed the
 * stage. The operator's honest answer to a question nobody asked for is «do
 * nothing beyond the instruction», so a declining option is preferred.
 *
 * When the model offers no way to decline, there is no safe answer — the first
 * option goes back, and that is precisely why every off-script answer is
 * recorded: a run steered by one has to say so rather than let the next step
 * guess.
 */
function answerQuestions(
  host: Host,
  choose: 'grant' | 'decline'
): { stop: () => void; offScript: () => string[] } {
  let stopped = false;
  const seen = new Set<string>();
  const offScript: string[] = [];

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const pending = (await api(host, 'GET', '/question')) as Array<{
          id: string;
          questions?: Array<{ question?: string; options?: Array<{ label?: string } | string> }>;
        }>;
        for (const request of pending ?? []) {
          if (seen.has(request.id)) continue;
          seen.add(request.id);
          if (process.env.HOST_SMOKE_DEBUG) {
            logEvent(`  question: ${JSON.stringify(request).slice(0, 400)}`, 'yellow', 'question');
          }
          const consent = isConsentQuestion(request);
          const answers = (request.questions ?? [{}]).map((question) => {
            const labels = (question.options ?? []).map((option) =>
              typeof option === 'string' ? option : (option.label ?? '')
            );
            if (consent) {
              const wanted = labels.find((label) => label.toLowerCase().includes(choose));
              return [wanted ?? labels[0] ?? choose];
            }
            const refusal = DECLINING_WORDS.reduce<string | undefined>(
              (found, word) => found ?? labels.find((label) => label.toLowerCase().includes(word)),
              undefined
            );
            if (!consent) {
              const text = (question.question ?? '').replace(/\s+/gu, ' ').slice(0, 160);
              offScript.push(
                `${refusal ? 'declined' : 'answered with the only option offered'}: "${text}"`
              );
            }
            return [refusal ?? labels[0] ?? 'no'];
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
  return { stop: () => (stopped = true), offScript: () => [...offScript] };
}

const SESSION_LOG = join(import.meta.dirname!, '../../.memory/session.log');

function modelResponseText(parts: Part[], error: string): string {
  const response = parts
    .map((part) =>
      [
        part.text ?? '',
        part.state?.output ?? '',
        part.state?.error ?? '',
        part.tool ? `«tool:${part.tool}»` : '',
      ]
        .filter(Boolean)
        .join(' ')
    )
    .filter(Boolean)
    .join('\n');
  return [error, response].filter(Boolean).join('\n') || '(empty response)';
}

/** Persist a bounded, sanitized `say` exchange only in explicit trace mode. */
async function logExchange(
  instruction: string,
  agent: string | undefined,
  error: string,
  parts: Part[]
): Promise<void> {
  if (!isTraceEnabled()) return;

  const response = modelResponseText(parts, error);
  const lines = [
    '',
    `─── ${new Date().toISOString()} ───`,
    `→ agent: ${agent ?? '(default)'}`,
    `USER:\n${sanitizeTracePayload(instruction)}`,
    `MODEL:\n${sanitizeTracePayload(response)}`,
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
  const startedAt = performance.now();

  harnessLog(
    'debug',
    `say request: model=${model}${agent ? ` agent=${agent}` : ''} instruction.length=${text.length}`
  );
  if (isTraceEnabled()) {
    harnessLog('trace', `say request payload: ${sanitizeTracePayload(text.slice(0, 2000))}`);
  }

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

  const duration = performance.now() - startedAt;
  const parts = reply.parts ?? [];
  const error = reply.info?.error?.data?.message ?? '';

  harnessLog(
    'debug',
    `say response: ${parts.length} parts${error ? ` error=${error.slice(0, 200)}` : ''} duration=${duration.toFixed(1)}ms`
  );
  if (isTraceEnabled()) {
    const toolParts = parts.filter((p) => p.tool);
    if (toolParts.length > 0) {
      harnessLog(
        'trace',
        `say tools: [${toolParts.map((p) => `${p.tool}${p.state?.error ? ' ERROR' : p.state?.status ? ` status=${p.state.status}` : ''}`).join(', ')}]`
      );
    }
    const responseText = parts.map((p) => p.text ?? '').join('\n');
    if (responseText.length > 0) {
      harnessLog(
        'trace',
        `say response text: ${sanitizeTracePayload(responseText.slice(0, 2000))}`
      );
    }
    if (error) {
      harnessLog('trace', `say response error: ${sanitizeTracePayload(error.slice(0, 1000))}`);
    }
  }
  // Вопрос, которого сценарий не задавал, — это модель, ушедшая в сторону.
  // Он попадает в транскрипт шага, чтобы падение следующего шага называло
  // причину, а не гадало про стадию.
  const strayed = operator
    .offScript()
    .map((entry) => `[off-script question] ${entry}`)
    .join('\n');
  const transcript = [
    strayed,
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

  if (process.env.HOST_SMOKE_DEBUG) {
    logBlock('  USER:', text, 'cyan', 'user');
    logBlock('  MODEL:', modelResponseText(parts, error), 'magenta', 'model');
  }

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
    // A prompt that outlives the client's timeout aborts the whole scenario,
    // and the error it throws names no step — `cicd-full-cycle` reported only
    // "The operation timed out" and nothing about where. Announcing the step
    // before it runs is what makes the last line printed the answer.
    if (process.env.HOST_SMOKE_DEBUG) {
      const started = new Date().toISOString().slice(11, 19);
      logEvent(
        `  ${started} step[${attempt}]: ${options.instruction.slice(0, 90)}`,
        'blue',
        'step.start',
        { attempt }
      );
    }
    session = await say(host, sessionId, model, options.instruction, options.agent);
    lastState = session.state;
    const verdict = options.expect(session);
    if (process.env.HOST_SMOKE_DEBUG) {
      const result = verdict === true ? 'PASS' : `WAIT: ${String(verdict).slice(0, 180)}`;
      logEvent(
        `  state after step[${attempt}]: ${result}; ${debugSessionState(session)}`,
        verdict === true ? 'green' : 'yellow',
        'step.state',
        { attempt, status: verdict === true ? 'pass' : 'wait' }
      );
    }
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
  durationMs: number;
  status: 'pass' | 'fail' | 'blocked';
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

/**
 * The consent step: prepare the tag, then ask the operator with it verbatim.
 *
 * `type` names which consent this is — the same name the schema writes in
 * `consent:` on its transition. Omitted, it is `plan`.
 */
function consentInstruction(type?: string): string {
  return (
    'Do this in two tool calls and nothing else. ' +
    'First call `workflow-consent` with files ["plan.md"] and summary "smoke plan"' +
    (type ? ` and type "${type}"` : '') +
    '. Then call the `question` tool once, passing as the question text the ENTIRE ' +
    '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
    'character for character, with options labelled "grant" and "decline".'
  );
}

const CONSENT_INSTRUCTION = consentInstruction();

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

function debugSessionState(session: Session): string {
  const state = session.state as {
    currentStage?: string;
    stageGateResults?: Array<{ id?: string; status?: string }>;
    loopRuns?: Record<
      string,
      {
        taskId?: string;
        stage?: string;
        status?: string;
        gates?: Record<string, string>;
      }
    >;
  } | null;
  if (!state) return 'state=(none)';

  const sessionGates = (state.stageGateResults ?? [])
    .map((gate) => `${gate.id ?? '?'}=${gate.status ?? '?'}`)
    .join(',');
  const runs = Object.values(state.loopRuns ?? {})
    .map(
      (run) =>
        `${run.taskId ?? '?'}:${run.stage ?? '?'}:${run.status ?? '?'}(${Object.entries(
          run.gates ?? {}
        )
          .map(([id, status]) => `${id}=${status}`)
          .join(',')})`
    )
    .join(';');
  return `stage=${state.currentStage ?? '(none)'} sessionGates=[${sessionGates}] runs=[${runs}]`;
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
          'Call the tool `workflow-list` with no arguments, then reply with its output verbatim.',
        agent: ORCHESTRATOR,
        // Evidence the tool really ran: the reply carries the resolved
        // profilesDir, a temp path the model has no way to invent.
        expect: (s) =>
          (s.transcript.includes('profilesDir') && s.transcript.includes('smoke')) ||
          `workflow-list did not report the smoke profile: ${s.transcript.slice(0, 300)}`,
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'workflow-list ran through the host and listed the project profiles'
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
    title: 'workflow-create puts the session under the state machine',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'create');
      const result = await step(host, sessionId, model, {
        instruction:
          'Call the tool `workflow-create` with schemaId "smoke". Do nothing else and add no commentary.',
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
        instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow-create did not run',
      });
      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: git commit --allow-empty -m "smoke". ' +
          'Report what happened, verbatim.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const refused = /not allowed|refus|blocked|workflow|no entry covers/i.test(s.transcript);
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
  },
  {
    id: 'commit-gate',
    title: 'commit-task is refused while the gates have not passed',
    run: async (host, model) => {
      const sessionId = await newSession(host, 'commit-gate');
      await step(host, sessionId, model, {
        instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow-create did not run',
      });
      const result = await step(host, sessionId, model, {
        instruction:
          'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: too early". ' +
          'Report what happened, verbatim.',
        agent: ORCHESTRATOR,
        expect: (s) => {
          const receipt = (s.state as { deliveryReceipt?: string | null } | null)?.deliveryReceipt;
          if (receipt) return 'a delivery receipt was written before the gates passed';
          return /cannot commit|refus|not allowed/i.test(s.transcript) || 'no refusal surfaced';
        },
      });
      return {
        ok: result.ok,
        attempts: result.attempts,
        evidence: result.ok
          ? 'the delivery guard refused the call and no receipt was written'
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
        instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
        agent: ORCHESTRATOR,
        expect: (s) => s.state !== null || 'workflow-create did not run',
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
    id: 'commit-cwd',
    title: 'A commit that matches the permit is receipted',
    env: { HARNESS_AUTO_APPROVE: 'true' },
    run: async (host, model) => {
      const sessionId = await newSession(host, 'commit-cwd');
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
  // `comprehensive-full-cycle` was removed here on 2026-09-07: the profile it
  // drives is still being written, so the scenario reported a timeout rather
  // than anything about the plugin. Its profile stays under
  // `profile/comprehensive/` for whoever finishes it.
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

  const stages: Array<{
    instruction: string;
    agent?: string;
    expect: (s: Session) => boolean | string;
  }> = [
    {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      agent: ORCHESTRATOR,
      expect: (s) => s.state !== null || 'workflow-create did not run',
    },
    {
      instruction: CONSENT_INSTRUCTION,
      agent: ORCHESTRATOR,
      expect: (s) => stage(s) === 'tasks_ready' || `stage is ${stage(s)}, expected tasks_ready`,
    },
    {
      instruction:
        'Call the tool `workflow-tasks-set` with tasks ' +
        JSON.stringify(files.map((path) => ({ writeScope: [path], status: 'pending' }))) +
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
        // Вердикт ядра о ходе живёт на прогоне задачи, а не в сессионном
        // гейте: гейт агент может выставить себе сам, этот — нет.
        const runs = (s.state as { loopRuns?: Record<string, { checks?: string }> } | null)
          ?.loopRuns;
        const checks = Object.values(runs ?? {}).map((run) => run.checks);
        return (
          checks.some((value) => value === 'passed') ||
          `no run reports passing checks (got ${JSON.stringify(checks)})`
        );
      },
    },
    ...files.map((_, index) => ({
      instruction:
        `Call the tool \`workflow-tasks-set-status\` with taskId "task-${index}" and status "completed". ` +
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
    // Валидация всей работы целиком. Без неё сессия остаётся в `validation`, а
    // коммит объявлен действием стадии `commit` — до неё надо дойти.
    //
    // Раньше этих шагов не было и сценарий проходил: `commitBefore` выдавал
    // permit с любой стадии, стадия в решении не участвовала. Теперь участвует.
    {
      instruction:
        'Use the task tool with subagent_type "reviewer" and description "review the work", ' +
        'telling it to finish with exactly ' +
        '<workflow-result>{"gate":"review","status":"pass","summary":"reviewed",' +
        '"evidence":["src/smoke-1.ts"]}</workflow-result>',
      agent: ORCHESTRATOR,
      expect: (s: Session) => {
        const gates = (
          s.state as { stageGateResults?: Array<{ id: string; status: string }> } | null
        )?.stageGateResults;
        const review = gates?.find((gate) => gate.id === 'review')?.status;
        return review === 'passed' || `the session review gate is ${review ?? '(unset)'}`;
      },
    },
    {
      instruction:
        'Use the task tool with subagent_type "tester" and description "verify the work", ' +
        'telling it to finish with exactly ' +
        '<workflow-result>{"gate":"qa","status":"pass","summary":"verified",' +
        '"evidence":["src/smoke-1.ts"]}</workflow-result>',
      agent: ORCHESTRATOR,
      expect: (s: Session) =>
        stage(s) === 'commit' || `stage is ${stage(s)}, expected commit after both verdicts`,
    },
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

function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
}

async function main(): Promise<void> {
  installSignalHandlers();
  const wanted = process.argv.slice(2);
  const selected = wanted.length
    ? scenarios.filter((scenario) => wanted.includes(scenario.id))
    : scenarios;
  if (selected.length === 0) {
    logEvent(`No such scenario. Known: ${scenarios.map((s) => s.id).join(', ')}`, 'red', 'error');
    process.exit(2);
  }

  const hostVersion = hostVersionFromEnv();
  const binary = opencodeBinary(hostVersion);
  const model = await defaultModel(binary);
  const plugin = process.env.HOST_SMOKE_PLUGIN ?? buildPlugin();
  process.env.HOST_SMOKE_PLUGIN = plugin;

  logEvent(`model:  ${model}`, 'gray', 'run.start', { model, plugin, version: hostVersion });
  if (OUTPUT_FORMAT !== 'jsonl') {
    logEvent(`plugin: ${plugin}`, 'gray');
    logEvent(`opencode: ${binary}`, 'gray');
  }

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const startedAt = Date.now();
    logEvent(`▶ ${scenario.id} …`, 'cyan', 'scenario.start', { scenario: scenario.id });
    const host = await startHost({
      model,
      version: hostVersion,
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
        logEvent(`  state: ${JSON.stringify(lastState).slice(0, 1200)}`, 'red', 'scenario.state');
        const relevant = host
          .logs()
          .split('\n')
          .filter((line) => /session-guard|consent|DIAG|workflow/i.test(line));
        logEvent(
          `  host log:\n    ${relevant.slice(-25).join('\n    ')}`,
          'red',
          'scenario.host-log'
        );
      }
      const durationMs = Date.now() - startedAt;
      results.push({
        id: scenario.id,
        title: scenario.title,
        ...outcome,
        status: outcome.ok ? 'pass' : 'fail',
        durationMs,
      });
      logEvent(
        outcome.ok
          ? `PASS (${outcome.attempts} attempt(s), ${formatDuration(durationMs)})`
          : `FAIL (${formatDuration(durationMs)})`,
        outcome.ok ? 'green' : 'red',
        'scenario.result',
        {
          scenario: scenario.id,
          status: outcome.ok ? 'pass' : 'fail',
          attempts: outcome.attempts,
          durationMs,
        }
      );
      if (!outcome.ok)
        logEvent(`  ${outcome.evidence.split('\n').join('\n  ')}`, 'red', 'scenario.evidence');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        title: scenario.title,
        ok: false,
        status: 'fail',
        attempts: 0,
        evidence: `harness error: ${message}\n${host.logs().slice(-1500)}`,
        durationMs: Date.now() - startedAt,
      });
      logEvent('ERROR', 'red', 'scenario.result', {
        scenario: scenario.id,
        status: 'error',
        durationMs: Date.now() - startedAt,
      });
      logEvent(`  ${message}`, 'red', 'error');
      if (process.env.HOST_SMOKE_DEBUG)
        logEvent(host.logs().slice(-4000), 'red', 'scenario.host-log');
    } finally {
      await host.stop();
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const averageDurationMs = results.length
    ? results.reduce((total, result) => total + result.durationMs, 0) / results.length
    : 0;
  const report = [
    '# Host smoke — session-guard against a real opencode',
    '',
    `| Model | \`${model}\` |`,
    '|---|---|',
    `| Host version | ${hostVersion} (\`${binary}\`) |`,
    `| Plugin | \`${plugin.split('/').at(-1)}\` |`,
    `| Result | ${passed}/${results.length} scenarios passed |`,
    `| Average duration | ${formatDuration(averageDurationMs)} per scenario |`,
    '',
    '| # | Scenario | Result | Attempts | Duration | Evidence |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (result, index) =>
        `| ${index + 1} | ${result.title} | ${result.status === 'pass' ? '**PASS**' : result.status === 'blocked' ? '**BLOCKED**' : '**FAIL**'} | ${
          result.attempts
        } | ${formatDuration(result.durationMs)} | ${result.evidence.replace(/\n/g, ' ').slice(0, 300)} |`
    ),
    '',
  ].join('\n');

  const reportPath = join(import.meta.dir!, '../../docs/plans/host-smoke.md');
  await writeFile(reportPath, report, 'utf-8');
  logEvent(
    `\n${passed}/${results.length} passed — report written to ${reportPath}`,
    passed === results.length ? 'green' : 'red',
    'run.summary',
    { passed, total: results.length, averageDurationMs, reportPath }
  );
  process.exit(hostVersion === 'v2' ? 2 : passed === results.length ? 0 : 1);
}

await main();
