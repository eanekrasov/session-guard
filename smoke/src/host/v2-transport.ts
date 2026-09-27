/**
 * V2 transport strategy: the generated `@opencode/client` API.
 *
 * Everything this file knows — the client call shapes, agent switching, form answering by
 * the shared operator, how assistant messages are laid out — stays here. Scenarios and the
 * runner see the shared normalized result instead.
 */

import { log as harnessLog, type Host } from '../harness.ts';
import { PromptTimeoutError, createV2SmokeClient, type V2SmokeClient } from '../v2-client.ts';
import {
  buildPromptResult,
  compactParts,
  itemsAfterLastUser,
  normalizeSessionContent,
  readNormalizedWorkflowState,
  type HostTransport,
} from './transport.ts';
import type {
  NormalizedPart,
  PromptInput,
  PromptResult,
  SmokeSession,
  SmokeWorkflowState,
} from './types.ts';

export interface SessionClientTransportOptions {
  /** Agent the session is switched to, the V2 equivalent of V1's per-message agent. */
  agent?: string;
  /** How long one prompt may run before the client reports it instead of waiting. */
  promptTimeoutMs?: number;
}

/** Untrusted host payload read field by field; a declared type never validates JSON. */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function createdAt(value: unknown): number {
  const created = fields(fields(value).time).created;
  return typeof created === 'number' ? created : 0;
}

function messageType(value: unknown): unknown {
  return fields(value).type;
}

/**
 * Content of the assistant turns the last user instruction produced.
 *
 * Messages are ordered by the timestamps the host itself wrote, because the API promises
 * no array direction: with the last user message as the boundary, the instruction's own
 * output is unambiguous under either order.
 */
export function assistantContentAfterLastUser(messages: unknown[]): unknown[] {
  return itemsAfterLastUser(
    messages.map((message) => {
      const content = fields(message).content;
      return {
        role: messageType(message),
        createdAt: createdAt(message),
        items: Array.isArray(content) ? content : [],
      };
    })
  );
}

export function createSessionClientTransport(
  host: Host,
  options: SessionClientTransportOptions = {},
  makeClient: (host: Host) => V2SmokeClient = (target) =>
    createV2SmokeClient(target, {
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.promptTimeoutMs === undefined
        ? {}
        : { promptTimeoutMs: options.promptTimeoutMs }),
    })
): HostTransport {
  const client = makeClient(host);

  return {
    async createSession(title: string): Promise<SmokeSession> {
      return { id: await client.createSession(title), hostKind: 'v2' };
    },

    async prompt(session: SmokeSession, input: PromptInput): Promise<PromptResult> {
      const notes: string[] = [];
      let timedOut = false;
      let error = '';
      let pendingInteraction = false;

      // V2 carries the agent on the session, not on the message, so a step naming another
      // agent is reported rather than silently run as the session's own agent.
      if (input.agent !== undefined && input.agent !== options.agent) {
        notes.push(
          `агент шага «${input.agent}» не применён: V2 переключает агента один раз, при создании сессии`
        );
      }

      harnessLog(
        'debug',
        `say request: session=${session.id} instruction.length=${input.text.length}`
      );
      try {
        await client.prompt(session.id, input.text);
      } catch (caught) {
        if (!(caught instanceof PromptTimeoutError)) throw caught;
        timedOut = true;
        error = caught.message;
        pendingInteraction = caught.pendingForms > 0;
      }

      let parts: NormalizedPart[] = [];
      try {
        const content = assistantContentAfterLastUser(await client.listMessages(session.id));
        parts = compactParts(content.flatMap((entry) => normalizeSessionContent(entry)));
      } catch (caught) {
        // The turn happened; only reading it back failed, so it is reported as evidence
        // instead of replacing the scenario's actual finding.
        const reason = caught instanceof Error ? caught.message : String(caught);
        notes.push(`не удалось прочитать сообщения сессии: ${reason}`);
      }

      return buildPromptResult(
        {
          status: timedOut ? 'timed-out' : 'completed',
          parts,
          error,
          ...(pendingInteraction ? { pendingInteraction: true } : {}),
          notes: [...notes, ...client.offScript()],
        },
        await readNormalizedWorkflowState(host, session.id),
        // This strategy holds a live `Host`, so the evidence really comes from one.
        'real-host'
      );
    },

    readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null> {
      return readNormalizedWorkflowState(host, session.id);
    },

    async removeSession(session: SmokeSession): Promise<void> {
      await client.removeSession(session.id);
    },
  };
}
