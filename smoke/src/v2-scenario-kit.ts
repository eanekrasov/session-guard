import { readWorkflowSession, type Host } from './harness.ts';
import { PromptTimeoutError, createV2SmokeClient, type V2SmokeClient } from './v2-client.ts';

/**
 * What every V2 scenario is built from.
 *
 * V1 drives the host's HTTP API directly through `scenario-kit.ts`; V2 goes through the generated
 * client and the host's forms, so it has its own shapes and its own step driver — but a V2 scenario
 * asserts what a V1 one does: the durable workflow state the plugin persisted, not the model's
 * story about it.
 */

export interface V2State {
  currentStage?: unknown;
  approvals?: Array<{ type?: unknown; status?: unknown }>;
  tasks?: Record<string, Array<{ status?: unknown }>>;
}

export interface V2Step {
  instruction: string;
  expect: (state: V2State) => true | string;
}

export interface V2Scenario {
  id: string;
  title: string;
  /** The profile agent this scenario drives, as V1 drives `orchestrator`. */
  agent: string;
  steps: V2Step[];
}

const PLAN = 'plan.md';

/**
 * The agent the V1 runner drives every instruction with (`scenario-kit.ts`, `ORCHESTRATOR`). V2's
 * session must be switched to it for the same scenarios to mean the same thing: the smoke profile's
 * stages allow only this agent, and any other one is refused by the workflow's own rules.
 */
export const ORCHESTRATOR = 'orchestrator';

export function stage(state: V2State): string {
  return String(state.currentStage ?? '(none)');
}

/**
 * The consent step: prepare the tag, then ask the operator with it verbatim. The host's `question`
 * tool reaches V2 as a form, which the client answers.
 */
export const CONSENT_INSTRUCTION =
  'Do this in two tool calls and nothing else. ' +
  `First call \`workflow-consent\` with files ["${PLAN}"] and summary "smoke plan". ` +
  'Then call the `question` tool once, passing as the question text the ENTIRE ' +
  '<consent-request ...>...</consent-request> tag that the first tool printed, copied ' +
  'character for character, with options labelled "grant" and "decline".';

export interface V2ScenarioOutcome {
  ok: boolean;
  attempts: number;
  evidence: string;
}

/**
 * Run one scenario in its own session, retrying a step whose expectation does not hold yet: a live
 * model may ignore an instruction, and a step that needed retries is a prompt problem rather than a
 * finding. The session is removed whether the scenario passed, failed, or threw.
 *
 * A step is judged by the state the plugin persisted, never by the model finishing its turn. V2's
 * agent keeps working after the tool call it was asked for — reading the plan, inspecting the
 * schema — so a turn can legitimately outlive the prompt budget. The budget bounds the wait; it is
 * not the verdict, and a run that hit it says so in its evidence.
 */
export async function runV2Scenario(
  host: Host,
  scenario: V2Scenario,
  attemptsPerStep: number,
  makeClient: (host: Host) => V2SmokeClient = (h) =>
    createV2SmokeClient(h, { agent: scenario.agent })
): Promise<V2ScenarioOutcome> {
  const client = makeClient(host);
  const sessionId = await client.createSession(scenario.id);
  let attempts = 0;
  const stillRunning: string[] = [];

  try {
    for (const step of scenario.steps) {
      let detail = '';
      let satisfied = false;
      const allowed = Math.max(1, attemptsPerStep);
      for (let attempt = 1; attempt <= allowed && !satisfied; attempt += 1) {
        attempts += 1;
        try {
          await client.prompt(sessionId, step.instruction);
        } catch (error) {
          if (!(error instanceof PromptTimeoutError)) throw error;
          stillRunning.push(error.message);
        }
        const state = ((await readWorkflowSession(host, sessionId)) ?? {}) as V2State;
        const verdict = step.expect(state);
        if (verdict === true) satisfied = true;
        else detail = verdict;
      }
      if (!satisfied) {
        const state = ((await readWorkflowSession(host, sessionId)) ?? {}) as V2State;
        return {
          ok: false,
          attempts,
          evidence: [
            detail,
            `state: ${JSON.stringify(state).slice(0, 600)}`,
            ...stillRunning.map((note) => `the turn was still running: ${note}`),
          ].join('\n'),
        };
      }
    }

    const offScript = client.offScript();
    const notes = [
      ...(offScript.length ? [`off-script answers: ${offScript.join('; ')}`] : []),
      ...stillRunning.map((note) => `the turn was still running: ${note}`),
    ];
    return {
      ok: true,
      attempts,
      evidence: notes.length
        ? notes.join('\n')
        : 'every instruction produced the durable workflow state it claimed',
    };
  } finally {
    // A session the host already dropped is not a reason to lose the result.
    await client.removeSession(sessionId).catch(() => undefined);
  }
}
