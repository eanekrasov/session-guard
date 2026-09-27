import { readWorkflowSession, type Host } from './harness.ts';
import { PromptTimeoutError, createV2SmokeClient, type V2SmokeClient } from './v2-client.ts';

/**
 * Из чего состоит каждый V2-сценарий.
 *
 * V1 управляет HTTP API хоста напрямую через `scenario-kit.ts`; V2 проходит через сгенерированный
 * клиент и формы хоста, так что у V2 собственные типы и собственный движок шагов — но V2-сценарий
 * проверяет то же, что и V1: устойчивое состояние workflow, сохранённое плагином, а не рассказ
 * модели об этом состоянии.
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
  /** Агент профиля, которым управляет этот сценарий — как V1 управляет `orchestrator`. */
  agent: string;
  steps: V2Step[];
}

const PLAN = 'plan.md';

/**
 * Агент, которым V1-раннер отправляет каждую инструкцию (`scenario-kit.ts`, `ORCHESTRATOR`).
 * V2-сессия должна быть переключена на него, чтобы те же сценарии означали то же самое:
 * стадии smoke-профиля разрешают только этого агента, и любой другой отклоняется правилами
 * workflow.
 */
export const ORCHESTRATOR = 'orchestrator';

export function stage(state: V2State): string {
  return String(state.currentStage ?? '(none)');
}

/**
 * Шаг согласия: подготовить тег, затем дословно спросить оператора этим тегом. Инструмент
 * `question` хоста в V2 приходит как форма, на которую отвечает клиент.
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
 * Запустить один сценарий в собственной сессии, повторяя шаг, чьё ожидание ещё не выполнено:
 * живая модель может проигнорировать инструкцию, и шаг, потребовавший повторов, — это проблема
 * промпта, а не находка. Сессия удаляется независимо от того, прошёл сценарий, упал или выбросил
 * исключение.
 *
 * Шаг оценивается по состоянию, которое сохранил плагин, а не по завершению хода модели.
 * V2-агент продолжает работу после вызванного инструмента — читает план, изучает схему, — так
 * что ход может законно выйти за лимит промпта. Лимит ограничивает ожидание, но не является
 * вердиктом; прогон, достигший лимита, сообщает об этом в своём доказательстве.
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
    // Сессия, которую хост уже удалил, не повод терять результат.
    await client.removeSession(sessionId).catch(() => undefined);
  }
}
