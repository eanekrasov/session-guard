/**
 * Обмен с V1-хостом, нужный живому транспорту: ответы на вопросы и трассировка.
 *
 * Раньше это жило в `scenario-kit.ts` вместе с legacy-раннером. Сам раннер удалён вместе с
 * compatibility bridge, а эти helper-ы нужны и дальше: V1 блокирует инструмент `question` до
 * ответа оператора, поэтому транспорт обязан отвечать, а трассировка обмена — единственный способ
 * увидеть, чем именно ответил хост.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO_ROOT, api, isTraceEnabled, sanitizeTracePayload, type Host } from '../harness.ts';
import { log } from '../log.ts';
import { chooseLabel } from '../operator.ts';
import { createSessionEventStream, type SessionEventStream } from './session-events.ts';

export interface Part {
  type: string;
  tool?: string;
  text?: string;
  state?: { status?: string; error?: string; output?: string; input?: unknown };
}

export interface RawV1ResponseDiagnostics {
  text: string;
  hasWorkflowResult: boolean;
  hasDsmlToolResult: boolean;
}

const TASK_CHILD_SESSION_RE = /<task\s+id="([^"]+)"[^>]*>/u;

export function extractTaskChildSessionId(text: string): string | undefined {
  return TASK_CHILD_SESSION_RE.exec(text)?.[1];
}

/**
 * Describe the result text stored by V1 before the shared smoke normalization runs.
 * This is diagnostic evidence only; it deliberately does not rewrite the host payload.
 */
export function rawV1ResponseDiagnostics(parts: Part[], error: string): RawV1ResponseDiagnostics {
  const text = modelResponseText(parts, error);
  return {
    text,
    hasWorkflowResult: text.includes('<workflow-result>'),
    hasDsmlToolResult: text.includes('<｜DSML｜tool-result>'),
  };
}

export interface V1SseEvent {
  type: string;
  data: unknown;
}

export interface V1EventSubscription {
  stop: () => void;
  done: Promise<Error | undefined>;
}

export interface V1SessionEvents {
  setDecision(decision: 'grant' | 'decline'): void;
  waitForTerminal(signal?: AbortSignal): Promise<V1SseEvent>;
  stop(): Promise<void>;
  offScript(): string[];
  answered(): AnsweredQuestion[];
}

const MAX_V1_SSE_CONNECTION_ATTEMPTS = 5;
const V1_SSE_RECONNECT_DELAYS_MS = [10, 25, 50, 100] as const;

function eventSessionId(event: V1SseEvent): string | undefined {
  if (typeof event.data !== 'object' || event.data === null) return undefined;
  const value = (event.data as { sessionID?: unknown }).sessionID;
  return typeof value === 'string' ? value : undefined;
}

export function isV1TerminalEvent(event: V1SseEvent, sessionId: string): boolean {
  if (eventSessionId(event) !== sessionId) return false;
  if (event.type === 'session.error') return true;
  if (event.type !== 'session.status') return false;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return false;
  const status = (data as { status?: unknown }).status;
  return (
    typeof status === 'object' && status !== null && (status as { type?: unknown }).type === 'idle'
  );
}

export function waitForV1Event(
  host: Host,
  predicate: (event: V1SseEvent) => boolean
): Promise<V1SseEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: V1EventSubscription;
    subscription = subscribeToV1Events(host, (event) => {
      if (!predicate(event)) return;
      settled = true;
      subscription.stop();
      resolve(event);
    });
    void subscription.done.then((error) => {
      if (settled) return;
      reject(error ?? new Error('[ERROR] V1 SSE завершился до terminal-события'));
    });
  });
}

export function waitForV1TerminalEvent(host: Host, sessionId: string): Promise<V1SseEvent> {
  return waitForV1Event(host, (event) => isV1TerminalEvent(event, sessionId));
}

/** Parse one complete SSE record. Blank records and malformed payloads are ignored. */
export function parseV1SseEvent(record: string): V1SseEvent | undefined {
  let eventType = '';
  const data: string[] = [];
  for (const line of record.split(/\r?\n/gu)) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  try {
    const payload = JSON.parse(data.join('\n')) as {
      type?: unknown;
      properties?: unknown;
    };
    if (typeof payload.type === 'string' && 'properties' in payload) {
      return { type: payload.type, data: payload.properties };
    }
    if (!eventType) return undefined;
    return { type: eventType, data: payload };
  } catch {
    return undefined;
  }
}

/** Subscribe to the V1 event stream and dispatch complete events to the caller. */
export function subscribeToV1Events(
  host: Host,
  onEvent: (event: V1SseEvent) => void | Promise<void>
): V1EventSubscription {
  const controller = new AbortController();
  let stopped = false;
  const done = (async (): Promise<Error | undefined> => {
    try {
      const response = await fetch(`${host.url}/event`, { signal: controller.signal });
      if (!response.ok) return new Error(`[ERROR] V1 SSE завершился с HTTP ${response.status}`);
      if (response.body === null) return new Error('[ERROR] V1 SSE не вернул тело потока');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const next = await reader.read();
        buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
        const records = buffer.split(/\r?\n\r?\n/gu);
        buffer = records.pop() ?? '';
        for (const record of records) {
          const event = parseV1SseEvent(record);
          if (event) {
            log('trace', `V1 SSE event: ${JSON.stringify(event)}`, {
              type: 'sse.event',
              fields: { event },
            });
            await onEvent(event);
          }
        }
        if (next.done) break;
      }
      const event = parseV1SseEvent(buffer);
      if (event) {
        log('trace', `V1 SSE event: ${JSON.stringify(event)}`, {
          type: 'sse.event',
          fields: { event },
        });
        await onEvent(event);
      }
      await reader.cancel().catch(() => undefined);
      return undefined;
    } catch (error) {
      if (stopped) return undefined;
      return error instanceof Error ? error : new Error(String(error));
    }
  })();

  return {
    stop: () => {
      stopped = true;
      controller.abort();
    },
    done,
  };
}

export function createV1SessionEvents(host: Host, sessionId: string): V1SessionEvents {
  const stream: SessionEventStream<V1SseEvent> = createSessionEventStream();
  const trackedSessions = new Set([sessionId]);
  const seen = new Set<string>();
  const offScript: string[] = [];
  const answered: AnsweredQuestion[] = [];
  let decision: 'grant' | 'decline' = 'grant';
  let stopped = false;
  let connectionAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let subscription: V1EventSubscription | undefined;

  const logSessionTree = (message: string): void => {
    log('debug', message, {
      type: 'sse.session-tree',
      fields: { rootSessionID: sessionId, trackedSessionIDs: [...trackedSessions] },
    });
  };

  const stopSubscription = (): void => {
    stopped = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stream.close();
    subscription?.stop();
    logSessionTree('V1 SSE stopped');
  };

  const handle = async (event: V1SseEvent): Promise<void> => {
    if (event.type === 'session.created') {
      if (typeof event.data !== 'object' || event.data === null) return;
      const info = (event.data as { info?: unknown }).info;
      if (typeof info !== 'object' || info === null) return;
      const child = info as { id?: unknown; parentID?: unknown };
      if (
        typeof child.id === 'string' &&
        typeof child.parentID === 'string' &&
        trackedSessions.has(child.parentID)
      ) {
        trackedSessions.add(child.id);
        logSessionTree(`V1 SSE session tracked: ${child.id}`);
      }
      return;
    }

    if (event.type === 'session.deleted') {
      const deletedSessionID = eventSessionId(event);
      if (deletedSessionID === undefined || !trackedSessions.delete(deletedSessionID)) return;
      logSessionTree(`V1 SSE session deleted: ${deletedSessionID}`);
      if (trackedSessions.size === 0) stopSubscription();
      return;
    }

    if (isV1TerminalEvent(event, sessionId)) stream.dispatch(event);
    if (event.type !== 'question.asked' || typeof event.data !== 'object' || event.data === null)
      return;
    const request = event.data as {
      id?: unknown;
      sessionID?: unknown;
      questions?: Array<{ question?: string; options?: Array<{ label?: string } | string> }>;
    };
    if (
      typeof request.id !== 'string' ||
      typeof request.sessionID !== 'string' ||
      !trackedSessions.has(request.sessionID) ||
      seen.has(request.id)
    )
      return;

    seen.add(request.id);
    const consent = isConsentQuestion(request);
    const answers = (request.questions ?? [{}]).map((question) => {
      const options = (question.options ?? []).map((option) =>
        typeof option === 'string' ? option : (option.label ?? '')
      );
      const choice = chooseLabel(options, decision, consent);
      if (!consent) {
        offScript.push(
          `${choice.refusal ? 'отказано' : 'дан ответ единственным предложенным вариантом'}: "${(
            question.question ?? ''
          )
            .replace(/\s+/gu, ' ')
            .slice(0, 160)}"`
        );
      }
      answered.push({
        id: request.id as string,
        kind: 'question',
        decision,
        label: choice.label,
        offered: options,
        consent,
      });
      return [choice.label];
    });
    await api(host, 'POST', `/question/${request.id}/reply`, { answers });
  };

  const start = (): void => {
    if (subscription !== undefined || stopped || trackedSessions.size === 0) return;
    connectionAttempts += 1;
    log('debug', 'V1 SSE connecting', {
      type: 'sse.connect',
      fields: {
        endpoint: `${host.url}/event`,
        attempt: connectionAttempts,
        maxAttempts: MAX_V1_SSE_CONNECTION_ATTEMPTS,
        rootSessionID: sessionId,
        trackedSessionIDs: [...trackedSessions],
      },
    });
    subscription = subscribeToV1Events(host, async (event) => {
      try {
        await handle(event);
      } catch (error) {
        stream.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    void subscription.done.then((error) => {
      subscription = undefined;
      if (stopped || trackedSessions.size === 0) return;
      const reason = error?.message ?? 'stream ended';
      if (connectionAttempts >= MAX_V1_SSE_CONNECTION_ATTEMPTS) {
        log('error', 'V1 SSE reconnect limit reached', {
          type: 'sse.reconnect.exhausted',
          fields: {
            endpoint: `${host.url}/event`,
            attempts: connectionAttempts,
            rootSessionID: sessionId,
            trackedSessionIDs: [...trackedSessions],
            reason,
          },
        });
        stream.fail(error ?? new Error('[ERROR] V1 SSE reconnect limit reached'));
        return;
      }
      const delay = V1_SSE_RECONNECT_DELAYS_MS[connectionAttempts - 1] ?? 100;
      log('warn', 'V1 SSE reconnect scheduled', {
        type: 'sse.reconnect',
        fields: {
          endpoint: `${host.url}/event`,
          attempt: connectionAttempts + 1,
          delayMs: delay,
          rootSessionID: sessionId,
          trackedSessionIDs: [...trackedSessions],
          reason,
        },
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        start();
      }, delay);
    });
  };

  return {
    setDecision(next): void {
      decision = next;
    },
    waitForTerminal(signal): Promise<V1SseEvent> {
      start();
      return stream.waitFor((event) => isV1TerminalEvent(event, sessionId), signal);
    },
    async stop(): Promise<void> {
      stopSubscription();
      await subscription?.done;
    },
    offScript: () => [...offScript],
    answered: () => [...answered],
  };
}

/**
 * Вопросы, заданные плагином, содержат его consent-тег; всё остальное — вопросы самой модели.
 */
export function isConsentQuestion(request: { questions?: Array<{ question?: string }> }): boolean {
  return (request.questions ?? []).some((entry) =>
    (entry?.question ?? '').includes('<consent-request')
  );
}

/**
 * Отвечать на вопросы хоста, пока выполняется промпт.
 *
 * Инструмент `question` хоста блокируется до ответа оператора, поэтому прогон
 * иначе завис бы. Harness играет роль оператора, а оператор отвечает на два
 * совершенно разных типа вопросов.
 *
 * **Consent-запрос** — это тема самого сценария: он получает решение, которое
 * запрашивала инструкция (по умолчанию: grant), — именно для этого и существует
 * механизм consent.
 *
 * Всё остальное — вопросы, выдуманные моделью: «How would you like to
 * proceed?» — и harness раньше отвечал на них ПЕРВОЙ опцией, которая почти
 * всегда была вариантом «да, продолжай». Так внесценарный вопрос превращался
 * в разрешение выйти за рамки сценария: `cicd-full-cycle` доходил до `test`,
 * а следующий шаг всё ещё ожидал `checkout`, и сбой списывали на стадию.
 * Честный ответ оператора на вопрос, которого никто не задавал, — «не делай
 * ничего сверх инструкции», поэтому предпочтительна опция отказа.
 *
 * Когда модель не предлагает способа отказать, безопасного ответа нет —
 * возвращается первая опция, и именно поэтому каждый ответ не по сценарию
 * записывается: прогон, направленный таким ответом, должен явно указать это,
 * а не заставлять следующий шаг гадать.
 */
export function answerQuestions(
  host: Host,
  choose: 'grant' | 'decline',
  sessionId?: string
): {
  stop: () => void;
  terminal: Promise<V1SseEvent | Error>;
  offScript: () => string[];
  answered: () => AnsweredQuestion[];
} {
  let stopped = false;
  const seen = new Set<string>();
  const allowedSessions = new Set(sessionId === undefined ? [] : [sessionId]);
  const offScript: string[] = [];
  const answered: AnsweredQuestion[] = [];
  let resolveTerminal!: (event: V1SseEvent | Error) => void;
  const terminal = new Promise<V1SseEvent | Error>((resolve) => {
    resolveTerminal = resolve;
  });

  const handle = async (event: V1SseEvent): Promise<void> => {
    if (isV1TerminalEvent(event, sessionId ?? '')) {
      resolveTerminal(event);
      return;
    }
    if (event.type === 'question.replied') return;
    if (event.type === 'session.created') {
      if (typeof event.data !== 'object' || event.data === null) return;
      const info = (event.data as { info?: unknown }).info;
      if (typeof info !== 'object' || info === null) return;
      const session = info as { id?: unknown; parentID?: unknown };
      if (
        typeof session.id === 'string' &&
        typeof session.parentID === 'string' &&
        allowedSessions.has(session.parentID)
      ) {
        allowedSessions.add(session.id);
      }
      return;
    }
    if (event.type !== 'question.asked' || typeof event.data !== 'object' || event.data === null)
      return;
    const request = event.data as {
      id?: unknown;
      sessionID?: unknown;
      questions?: Array<{ question?: string; options?: Array<{ label?: string } | string> }>;
    };
    if (
      typeof request.id !== 'string' ||
      typeof request.sessionID !== 'string' ||
      !allowedSessions.has(request.sessionID) ||
      seen.has(request.id)
    )
      return;
    seen.add(request.id);
    const consent = isConsentQuestion(request);
    const answers = (request.questions ?? [{}]).map((question) => {
      const options = (question.options ?? []).map((option) =>
        typeof option === 'string' ? option : (option.label ?? '')
      );
      const choice = chooseLabel(options, choose, consent);
      if (!consent) {
        const text = (question.question ?? '').replace(/\s+/gu, ' ').slice(0, 160);
        offScript.push(
          `${choice.refusal ? 'отказано' : 'дан ответ единственным предложенным вариантом'}: "${text}"`
        );
      }
      answered.push({
        id: request.id as string,
        kind: 'question',
        decision: choose,
        label: choice.label,
        offered: options,
        consent,
      });
      return [choice.label];
    });
    for (const entry of answered.filter((item) => item.id === request.id)) {
      log('debug', `operator answered: ${entry.label}`, {
        type: 'interaction.answer',
        fields: {
          kind: entry.kind,
          id: entry.id,
          isConsent: entry.consent,
          decision: entry.decision,
          label: entry.label,
          offered: entry.offered,
        },
      });
    }
    await api(host, 'POST', `/question/${request.id}/reply`, { answers });
  };

  const subscription = subscribeToV1Events(host, handle);
  void subscription.done.then((error) => {
    resolveTerminal(error ?? new Error('[ERROR] V1 SSE завершился до terminal-события'));
  });
  return {
    stop: () => {
      stopped = true;
      subscription.stop();
    },
    terminal,
    offScript: () => [...offScript],
    answered: () => [...answered],
  };
}

/** One question the operator answered, in the host's own terms. */
export interface AnsweredQuestion {
  id: string;
  kind: 'question';
  decision: 'grant' | 'decline';
  /** The label that was sent back. */
  label: string;
  /** Labels the host offered. */
  offered: string[];
  /** Whether the question carried the plugin's consent tag. */
  consent: boolean;
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
  return [error, response].filter(Boolean).join('\n') || '(пустой ответ)';
}

/** Сохранять ограниченный санитизированный обмен `say` только в явном trace-режиме. */
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
