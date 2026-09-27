import { OpenCode, type FormField, type FormInfo, type OpenCodeClient } from '@opencode/client';

import { type Host } from './harness.ts';
import { chooseLabel, type OperatorDecision } from './operator.ts';

/** The answer a form expects: one value per field key. */
export type FormAnswer = Record<string, string | number | boolean | Array<string>>;

export interface V2SmokeClient {
  createSession(title: string): Promise<string>;
  /**
   * Send one instruction and play the operator until the session settles.
   *
   * Throws `PromptTimeoutError` when the host outlives the prompt budget
   * (`HOST_SMOKE_PROMPT_TIMEOUT_MS`, default 60s): a prompt that never settles
   * is a finding about the host, so the scenario reports it rather than
   * retrying or waiting forever.
   */
  prompt(sessionId: string, text: string, decision?: OperatorDecision): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  /** Answers given to questions the scenario never asked, in order. */
  offScript(): string[];
}

export type V2SmokeTransport = typeof fetch;

/**
 * How long one prompt may run before the client calls it a finding.
 *
 * A live model is slow, not wedged; measured on this host, a single
 * tool-calling instruction spent ~32s inside `session.wait` and settled. The
 * budget only has to be several times that, because its job is to turn an
 * unbounded wait into a reported failure, not to time the model.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;

/** Resolve the prompt budget; an unusable value falls back to the default. */
export function promptTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HOST_SMOKE_PROMPT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROMPT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROMPT_TIMEOUT_MS;
}

/**
 * A prompt that outlived its budget.
 *
 * The client cannot tell a slow model from a wedged host, so when the budget
 * runs out it stops waiting and hands the scenario a finding to report instead
 * of hanging. The message carries what the host was still waiting on, because
 * that is the only evidence left once the call is abandoned.
 */
export class PromptTimeoutError extends Error {
  constructor(operation: string, budgetMs: number, detail: string) {
    super(`[ERROR] ${operation} did not settle within ${budgetMs}ms: ${detail}`);
    this.name = 'PromptTimeoutError';
  }
}

/**
 * The V2 host ignores an inherited `OPENCODE_SERVER_PASSWORD`: it generates its
 * own credential and requires it on every `/api` call. Without the header the
 * server answers 401 with an empty body, and the generated client reports that
 * as `UnsupportedContentType` — an authorization failure wearing a
 * content-type costume.
 */
export function createV2SmokeTransport(authHeader?: string): V2SmokeTransport {
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    if (authHeader && !headers.has('authorization')) headers.set('authorization', authHeader);
    const response = await fetch(input, { ...init, headers });
    if (response.headers.get('content-type')) return response;

    const body = await response.arrayBuffer();
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response(body, response);
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('content-type', 'application/json');
    return new Response(body, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    });
  }) as typeof fetch;
  transport.preconnect = fetch.preconnect;
  return transport;
}

/** Everything a form says, so the consent tag can be found wherever it landed. */
function formText(form: Pick<FormInfo, 'title' | 'fields'>): string {
  return [form.title, ...form.fields.flatMap((field) => [field.title, field.description])]
    .filter(Boolean)
    .join(' ');
}

export interface FormAnswerPlan {
  answer: FormAnswer;
  /** Answers that were not what the instruction asked for, and why. */
  offScript: string[];
}

/**
 * What the operator answers on one form.
 *
 * The plugin's consent request reaches V2 as a form, and the tag that says so is
 * copied into the question text — so the tag, wherever it lands, is what makes
 * this the scenario's own subject rather than a question the model invented.
 */
export function planFormAnswer(
  form: Pick<FormInfo, 'title' | 'fields'>,
  decision: OperatorDecision
): FormAnswerPlan {
  const consent = formText(form).includes('<consent-request');
  const answer: FormAnswer = {};
  const offScript: string[] = [];

  for (const field of form.fields) {
    const label = field.title ?? field.key;
    const options = optionsOf(field);
    if (options) {
      const choice = chooseLabel(
        options.map((option) => option.label),
        decision,
        consent
      );
      const option = options.find((candidate) => candidate.label === choice.label);
      if (!option) {
        offScript.push(`no option matched for "${label}"`);
        continue;
      }
      answer[field.key] = field.type === 'multiselect' ? [option.value] : option.value;
      continue;
    }
    if (field.type === 'boolean') {
      answer[field.key] = field.default ?? false;
      continue;
    }
    if (field.type === 'string') {
      // Free text. The operator has nothing of his own to add to the
      // instruction, so the field's own default is the honest answer.
      answer[field.key] = field.default ?? '';
      if (!consent) offScript.push(`answered the free-text question "${label}"`);
      continue;
    }
    offScript.push(`field "${label}" has type ${field.type}, which the operator cannot answer`);
  }

  return { answer, offScript };
}

function optionsOf(field: FormField): Array<{ label: string; value: string }> | undefined {
  if (field.type === 'multiselect') return field.options;
  if (field.type === 'string' && field.options?.length) return field.options;
  return undefined;
}

export interface V2SmokeClientOptions {
  /** How long one prompt may run; defaults to `HOST_SMOKE_PROMPT_TIMEOUT_MS`. */
  promptTimeoutMs?: number;
  /**
   * The agent the session runs as.
   *
   * V1 sends `agent` with every message, and the smoke profile's stages allow
   * only `orchestrator`: a session left on the host default (`build`) is refused
   * by its own workflow rules (`Refused workflow-tasks-set … allowed:
   * ["orchestrator"]`), and its turn runs on instead of stopping at the
   * instruction.
   */
  agent?: string;
}

/** What one sweep found: how many forms it answered. */
interface SweepResult {
  answered: number;
}

export function createV2SmokeClient(host: Host, options: V2SmokeClientOptions = {}): V2SmokeClient {
  const transport = createV2SmokeTransport(host.authHeader);
  const client = OpenCode.make({ baseUrl: host.url, fetch: transport });
  // One client drives one scenario session, so the record of what was already
  // answered outlives a single prompt: a form answered in an earlier prompt is
  // never answered twice.
  const seen = new Set<string>();
  const notes: string[] = [];
  // What the host last told us it was waiting on. Recorded before the replies,
  // so a reply the host never answers still shows up in a timeout message.
  let waitingForms = 0;

  /** Answer everything the host is waiting on, and report what is left. */
  async function sweep(sessionId: string, decision: OperatorDecision): Promise<SweepResult> {
    const forms = await client.session.form.list({ sessionID: sessionId });
    const unanswered = (): number => forms.filter((form) => !seen.has(form.id)).length;
    waitingForms = unanswered();
    let answered = 0;
    for (const form of forms) {
      if (seen.has(form.id)) continue;
      seen.add(form.id);
      const plan = planFormAnswer(form, decision);
      notes.push(...plan.offScript);
      try {
        await client.session.form.reply({
          sessionID: sessionId,
          formID: form.id,
          answer: plan.answer,
        });
        answered += 1;
      } catch (error) {
        // Leave it answerable: a form the host cancelled mid-reply must not
        // hide one that still waits.
        seen.delete(form.id);
        notes.push(
          `reply to form ${form.id} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    waitingForms = unanswered();
    return { answered };
  }

  return {
    async createSession(title: string): Promise<string> {
      const session = await client.session.create({
        title,
        location: { directory: host.workDir },
      });
      if (options.agent) {
        await client.session.switchAgent({ sessionID: session.id, agent: options.agent });
      }
      return session.id;
    },

    async prompt(
      sessionId: string,
      text: string,
      decision: OperatorDecision = 'grant'
    ): Promise<void> {
      const budgetMs = options.promptTimeoutMs ?? promptTimeoutMs();
      const deadline = Date.now() + budgetMs;

      const pendingNote = (): string =>
        waitingForms > 0
          ? `the host still waits on ${waitingForms} form(s)`
          : 'the host had no form pending';

      /**
       * Run one host call under the prompt's budget. A call that outlives it
       * is the finding: the check itself cannot be waited out, but the
       * abandoned call keeps whatever it already told us.
       */
      const bound = async <T>(operation: string, work: Promise<T>): Promise<T> => {
        const left = deadline - Date.now();
        if (left <= 0) throw new PromptTimeoutError(operation, budgetMs, pendingNote());
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new PromptTimeoutError(operation, budgetMs, pendingNote())),
                left
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      let stopped = false;
      const sweeper = (async () => {
        // Stop at the deadline: a sweep that outlived the budget would hide it.
        while (!stopped && Date.now() < deadline) {
          try {
            await bound('form sweep', sweep(sessionId, decision));
          } catch {
            // The server is busy, or the budget is gone; the prompt reports it.
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      })();

      try {
        await bound('session.prompt', client.session.prompt({ sessionID: sessionId, text }));
        await bound('session.wait', client.session.wait({ sessionID: sessionId }));
        // An answer changes what the rest of the prompt does, so whatever is
        // still waiting is answered and waited for again.
        for (let round = 0; round < 5; round += 1) {
          const swept = await bound('form sweep', sweep(sessionId, decision));
          if (swept.answered === 0) break;
          await bound('session.wait', client.session.wait({ sessionID: sessionId }));
        }
      } finally {
        stopped = true;
        // The sweeper has to stop, not finish: a sweep still in flight would
        // otherwise hold a prompt that already settled for the rest of the
        // budget. A late form is covered by the rounds above, not by this loop.
        await Promise.race([sweeper, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      }
    },

    async removeSession(sessionId: string): Promise<void> {
      await client.session.remove({ sessionID: sessionId });
    },

    offScript: () => [...notes],
  };
}

export type V2OpenCodeClient = OpenCodeClient;
