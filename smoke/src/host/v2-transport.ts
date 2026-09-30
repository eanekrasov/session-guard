/**
 * V2 transport strategy: the generated `@opencode/client` API.
 *
 * Everything this file knows — the client call shapes, agent switching, form answering by
 * the shared operator, how assistant messages are laid out — stays here. Scenarios and the
 * runner see the shared normalized result instead.
 */

import { log as harnessLog, type Host } from '../harness.ts';
import { createV2SmokeClient, type V2SmokeClient } from '../v2-client.ts';
import {
  buildPromptResult,
  compactParts,
  itemsAfterLastUser,
  normalizeSessionContent,
  readNormalizedWorkflowState,
  type HostTransport,
} from './transport.ts';
import { formatToolTrace, summarizeWorkflowCheckpoint } from '../trace.ts';
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
    })
): HostTransport {
  const client = makeClient(host);
  /** The agent the session currently runs as; V2 keeps it on the session, not on the message. */
  let currentAgent = options.agent;

  return {
    async createSession(title: string): Promise<SmokeSession> {
      return { id: await client.createSession(title), hostKind: 'v2' };
    },

    async prompt(session: SmokeSession, input: PromptInput): Promise<PromptResult> {
      const notes: string[] = [];

      // V2 carries the agent on the session, so a step that must run as another agent — the
      // worker the task guard refuses — is switched to before its prompt.
      if (input.agent !== undefined && input.agent !== currentAgent) {
        try {
          await client.switchAgent(session.id, input.agent);
          currentAgent = input.agent;
          notes.push(`агент сессии переключён на «${input.agent}»`);
        } catch (caught) {
          notes.push(
            `не удалось переключить агента сессии на «${input.agent}»: ${
              caught instanceof Error ? caught.message : String(caught)
            }`
          );
        }
      }

      harnessLog(
        'debug',
        `say request: session=${session.id} instruction.length=${input.text.length}`
      );
      await client.prompt(session.id, input.text, input.decision ?? 'grant');

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

      const result = buildPromptResult(
        {
          status: 'completed',
          parts,
          notes: [...notes, ...client.offScript()],
          interactions: client.answeredForms().map((form) => ({
            kind: 'form' as const,
            id: form.id,
            isConsent: form.consent,
            decision: form.decision,
            label: form.label,
            offered: form.offered,
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

    waitForStateChange(session: SmokeSession, signal?: AbortSignal): Promise<void> {
      if (client.waitForStateChange === undefined) return Promise.resolve();
      return client.waitForStateChange(session.id, signal);
    },

    async removeSession(session: SmokeSession): Promise<void> {
      await client.removeSession(session.id);
    },
  };
}
