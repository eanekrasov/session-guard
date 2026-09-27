/**
 * What every host smoke scenario is built from: the session shapes an assertion reads, the
 * operator policy the runner plays, and the steps (`say`, `step`, `prepareCommittableSession`)
 * that drive a live host.
 *
 * A scenario owns what it proves; this owns how a scenario talks to the host.
 */

import { spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  REPO_ROOT,
  api,
  isTraceEnabled,
  readWorkflowSession,
  sanitizeTracePayload,
} from './harness.ts';
import { log as harnessLog } from './harness.ts';
import type { Host } from './harness.ts';
import { logBlock, logEvent } from './log.ts';
import { chooseLabel } from './operator.ts';

export const ATTEMPTS = Number(process.env.HOST_SMOKE_ATTEMPTS ?? 3);

export interface Part {
  type: string;
  tool?: string;
  text?: string;
  state?: { status?: string; error?: string; output?: string; input?: unknown };
}
export interface Message {
  info: { role: string; error?: { data?: { message?: string } } };
  parts: Part[];
}

export interface Session {
  id: string;
  state: Record<string, unknown> | null;
  /** Everything the assistant produced for the last prompt. */
  parts: Part[];
  /** Tool output and errors, flattened for matching. */
  transcript: string;
}

/**
 * Questions the plugin raised carry its consent tag; anything else is the model's own.
 */
export function isConsentQuestion(request: { questions?: Array<{ question?: string }> }): boolean {
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
export function answerQuestions(
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
            const choice = chooseLabel(labels, choose, consent);
            if (!consent) {
              const text = (question.question ?? '').replace(/\s+/gu, ' ').slice(0, 160);
              offScript.push(
                `${choice.refusal ? 'declined' : 'answered with the only option offered'}: "${text}"`
              );
            }
            return [choice.label];
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

export const SESSION_LOG = join(REPO_ROOT, '.memory/session.log');

export function modelResponseText(parts: Part[], error: string): string {
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
export async function logExchange(
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
export async function say(
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

export async function step(
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

export interface ScenarioResult {
  id: string;
  title: string;
  ok: boolean;
  evidence: string;
  attempts: number;
  durationMs: number;
  status: 'pass' | 'fail' | 'blocked';
}

export type Scenario = {
  id: string;
  title: string;
  /** Profile id to use (defaults to 'smoke'). */
  profile?: string;
  /** Extra environment for this scenario's host. */
  env?: Record<string, string>;
  /** What the scenario proves, in the report. */
  run: (host: Host, model: string) => Promise<{ ok: boolean; evidence: string; attempts: number }>;
};

export const ORCHESTRATOR = 'orchestrator';

/**
 * The consent step: prepare the tag, then ask the operator with it verbatim.
 *
 * `type` names which consent this is — the same name the schema writes in
 * `consent:` on its transition. Omitted, it is `plan`.
 */
export function consentInstruction(type?: string): string {
  return (
    'Do this in two tool calls and nothing else. ' +
    'First call `workflow-consent` with files ["plan.md"] and summary "smoke plan"' +
    (type ? ` and type "${type}"` : '') +
    '. Then call the `question` tool once, passing as the question text the ENTIRE ' +
    '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
    'character for character, with options labelled "grant" and "decline".'
  );
}

export const CONSENT_INSTRUCTION = consentInstruction();

export interface RunView {
  stage?: string;
  status?: string;
  gates?: Record<string, string>;
}

/** The task run the loop is working, as the plugin persisted it. */
export function firstRun(session: Session): RunView | undefined {
  const runs = (session.state as { loopRuns?: Record<string, RunView> } | null)?.loopRuns;
  return runs ? Object.values(runs)[0] : undefined;
}

export function stage(session: Session): string {
  return String(session.state?.currentStage ?? '(none)');
}

export function debugSessionState(session: Session): string {
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

export async function newSession(host: Host, title: string): Promise<string> {
  const created = (await api(host, 'POST', '/session', { title })) as { id: string };
  return created.id;
}

/**
 * Drive a session to the point where a commit is legitimate: plan approved,
 * tasks set and completed, invariants passed by a real mutation.
 */
export async function prepareCommittableSession(
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
export function headOf(host: Host): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: host.workDir,
    encoding: 'utf-8',
  });
  return (result.stdout ?? '').trim();
}

/** The workflow session the last step read, for diagnosing a failure. */
export function lastStepState(): unknown {
  return lastState;
}
