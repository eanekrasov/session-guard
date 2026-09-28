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
import { logEvent } from '../log.ts';
import { chooseLabel } from '../operator.ts';

export interface Part {
  type: string;
  tool?: string;
  text?: string;
  state?: { status?: string; error?: string; output?: string; input?: unknown };
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
  choose: 'grant' | 'decline'
): {
  stop: () => void;
  offScript: () => string[];
  answered: () => AnsweredQuestion[];
} {
  let stopped = false;
  const seen = new Set<string>();
  const offScript: string[] = [];
  const answered: AnsweredQuestion[] = [];

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
          const labels: string[] = [];
          const answers = (request.questions ?? [{}]).map((question) => {
            const options = (question.options ?? []).map((option) =>
              typeof option === 'string' ? option : (option.label ?? '')
            );
            labels.push(...options);
            const choice = chooseLabel(options, choose, consent);
            if (!consent) {
              const text = (question.question ?? '').replace(/\s+/gu, ' ').slice(0, 160);
              offScript.push(
                `${choice.refusal ? 'отказано' : 'дан ответ единственным предложенным вариантом'}: "${text}"`
              );
            }
            // The answer the host will actually receive, so a caller can report what was sent.
            answered.push({
              id: request.id,
              kind: 'question',
              decision: choose,
              label: choice.label,
              offered: options,
              consent,
            });
            return [choice.label];
          });
          await api(host, 'POST', `/question/${request.id}/reply`, { answers });
        }
      } catch {
        // Сервер занят или недоступен; сам промпт сообщит об ошибке.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  };
  void loop();
  return {
    stop: () => (stopped = true),
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
