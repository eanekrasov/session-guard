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

export interface Part {
  type: string;
  tool?: string;
  text?: string;
  state?: { status?: string; error?: string; output?: string; input?: unknown };
}

export interface V1SseEvent {
  type: string;
  data: unknown;
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
  offScript: () => string[];
  answered: () => AnsweredQuestion[];
} {
  let stopped = false;
  const events = new AbortController();
  const seen = new Set<string>();
  const allowedSessions = new Set(sessionId === undefined ? [] : [sessionId]);
  const offScript: string[] = [];
  const answered: AnsweredQuestion[] = [];

  const handle = async (event: V1SseEvent): Promise<void> => {
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

  const loop = async (): Promise<void> => {
    try {
      const response = await fetch(`${host.url}/event`, { signal: events.signal });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const records = buffer.split(/\r?\n\r?\n/gu);
        buffer = records.pop() ?? '';
        for (const record of records) {
          const event = parseV1SseEvent(record);
          if (event) await handle(event);
        }
      }
    } catch {
      // The prompt reports the failure; this listener must not reject its caller.
    }
  };
  void loop();
  return {
    stop: () => {
      stopped = true;
      events.abort();
    },
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
