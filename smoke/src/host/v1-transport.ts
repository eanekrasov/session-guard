/**
 * V1 transport strategy: the legacy HTTP API of `opencode serve`.
 *
 * Everything this file knows — endpoints, where the agent travels, how questions are
 * polled, which fields carry tool output — stays here. Scenarios and the runner see the
 * shared normalized result instead.
 */

import {
  api,
  type Host,
  log as harnessLog,
  isTraceEnabled,
  sanitizeTracePayload,
} from '../harness.ts';
import { log } from '../log.ts';
import { answerQuestions, logExchange, modelResponseText, type Part } from './v1-exchange.ts';
import {
  buildPromptResult,
  compactParts,
  itemsAfterLastUser,
  normalizeLegacyPart,
  readNormalizedWorkflowState,
  type HostTransport,
} from './transport.ts';
import { formatToolTrace, summarizeWorkflowCheckpoint } from '../trace.ts';
import type { PromptInput, PromptResult, SmokeSession, SmokeWorkflowState } from './types.ts';

export interface LegacyTransportOptions {
  /** Model identifier the host should run, `provider/model`. */
  model: string;
  /** Agent every prompt of this host runs as, unless the step names its own. */
  agent?: string;
}

/** The legacy message response, read field by field. */
interface LegacyMessage {
  info?: { error?: { data?: { message?: string } } };
  parts?: Part[];
}

/** One stored message of the session, as the legacy list endpoint reports it. */
interface LegacyMessageEntry {
  info?: { role?: string; time?: { created?: number } };
  parts?: Part[];
}

/**
 * The parts the host stored for this turn.
 *
 * `POST /session/:id/message` answers with the turn's *last* message, so a tool call from an
 * earlier step of the same turn is invisible there; the whole session is listed instead. The
 * boundary is the session length measured *before* the prompt: an answered question is stored
 * as a user message of its own, so "after the last user message" would cut away the very tool
 * calls a consent turn needs to show. Reading it back can fail on its own, and the turn has
 * already happened by then, so the answer is reported as missing rather than replacing the
 * scenario's finding.
 */
async function listedTurnParts(
  host: Host,
  sessionId: string,
  from: number | undefined
): Promise<Part[] | undefined> {
  try {
    const listed = (await api(host, 'GET', `/session/${sessionId}/message`)) as
      LegacyMessageEntry[] | undefined;
    const messages = Array.isArray(listed) ? listed : [];
    const items =
      from === undefined
        ? // No boundary was measured; fall back to the last instruction the session holds.
          itemsAfterLastUser(
            messages.map((message) => ({
              role: message.info?.role,
              createdAt: message.info?.time?.created ?? 0,
              items: message.parts ?? [],
            }))
          )
        : messages
            .slice(from)
            .filter((message) => message.info?.role === 'assistant')
            .flatMap((message) => message.parts ?? []);
    return items as Part[];
  } catch (error) {
    harnessLog(
      'warn',
      `не удалось прочитать сообщения сессии: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/** How many messages the session already holds, measured before the prompt is sent. */
async function listedCount(host: Host, sessionId: string): Promise<number | undefined> {
  try {
    const listed = (await api(host, 'GET', `/session/${sessionId}/message`)) as
      unknown[] | undefined;
    return Array.isArray(listed) ? listed.length : undefined;
  } catch {
    return undefined;
  }
}

export function createLegacyHttpTransport(
  host: Host,
  options: LegacyTransportOptions
): HostTransport {
  return {
    async createSession(title: string): Promise<SmokeSession> {
      // Поле agent в POST /session читается сервером как Session.CreateInput.agent:
      //   packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:159-176
      //   → createRaw парсит тело как Session.CreateInput
      //   packages/opencode/src/session/session.ts:260-271
      //   → CreateInput: { title?: string, agent?: string, model?, parentID?, ... }
      // Агент, переданный при создании, фиксируется в сессии и используется для всех
      // последующих сообщений, если сообщение не переопределит его своим параметром agent.
      const body: Record<string, unknown> = { title };
      if (options.agent !== undefined) body.agent = options.agent;
      const created = (await api(host, 'POST', '/session', body)) as { id?: unknown };
      if (typeof created?.id !== 'string') {
        throw new Error('[ERROR] хост V1 не вернул идентификатор сессии при её создании');
      }
      return { id: created.id, hostKind: 'v1' };
    },

    async prompt(session: SmokeSession, input: PromptInput): Promise<PromptResult> {
      const agent = input.agent ?? options.agent;
      const [providerID, ...rest] = options.model.split('/');
      const startedAt = performance.now();
      harnessLog(
        'debug',
        `say request: model=${options.model}${agent ? ` agent=${agent}` : ''} instruction.length=${input.text.length}`
      );
      if (isTraceEnabled()) {
        harnessLog(
          'trace',
          `say request payload: ${sanitizeTracePayload(input.text.slice(0, 2000))}`
        );
      }

      // The host's `question` tool blocks until an operator answers, so the scenario would
      // hang without this loop. The operator policy itself is shared with V2, and the decision
      // comes from the step so a scenario can ask for a decline as well as a grant.
      const requested = input.decision ?? 'grant';
      // Measure the turn's lower boundary before the prompt: an answered question lands in the
      // session as a user message of its own, which a role-based boundary would misread.
      const boundary = await listedCount(host, session.id);
      const operator = answerQuestions(host, requested, session.id);
      let reply: LegacyMessage;
      try {
        reply = (await api(host, 'POST', `/session/${session.id}/message`, {
          model: { providerID, modelID: rest.join('/') },
          ...(agent === undefined ? {} : { agent }),
          parts: [{ type: 'text', text: input.text }],
        })) as LegacyMessage;
      } finally {
        operator.stop();
      }

      const rawParts = (await listedTurnParts(host, session.id, boundary)) ?? reply.parts ?? [];
      const error = reply.info?.error?.data?.message ?? '';
      harnessLog(
        'debug',
        `say response: ${rawParts.length} parts${error ? ` error=${error.slice(0, 200)}` : ''} duration=${(performance.now() - startedAt).toFixed(1)}ms`
      );
      log('debug', input.text, { type: 'user', color: 'cyan', label: '  USER:' });
      log('debug', modelResponseText(rawParts, error), {
        type: 'model',
        color: 'magenta',
        label: '  MODEL:',
      });
      await logExchange(input.text, agent, error, rawParts);

      const parts = compactParts(rawParts.map((part) => normalizeLegacyPart(part)));
      const result = buildPromptResult(
        {
          status: error ? 'failed' : 'completed',
          parts,
          error,
          // A question the scenario never asked is the model going off script; it belongs
          // in the transcript so the next unmet expectation names its cause.
          notes: operator.offScript().map((entry) => `[вопрос вне сценария] ${entry}`),
          // Every interaction the operator answered is reported in the shared vocabulary, so a
          // scenario can prove that a consent answer really reached the host.
          interactions: operator.answered().map((entry) => ({
            kind: 'question' as const,
            id: entry.id,
            isConsent: entry.consent,
            decision: entry.decision,
            label: entry.label,
            offered: entry.offered,
          })),
        },
        await readNormalizedWorkflowState(host, session.id),
        // This strategy holds a live `Host`, so the evidence really comes from one.
        'real-host'
      );
      harnessLog('debug', `tool.execute.after: ${formatToolTrace(result.turn.toolCalls)}`);
      harnessLog(
        'debug',
        `workflow checkpoint: ${summarizeWorkflowCheckpoint(
          result.workflowState,
          result.workflowState?.revision
        )}`
      );
      return result;
    },

    readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null> {
      return readNormalizedWorkflowState(host, session.id);
    },

    async removeSession(session: SmokeSession): Promise<void> {
      // The V1 API does not promise session deletion, and the host's temporary project is
      // removed with the process. Ask, but never lose a result over an unsupported route.
      await api(host, 'DELETE', `/session/${session.id}`).catch(() => undefined);
    },
  };
}
