import { OpenCode, type FormField, type FormInfo, type OpenCodeClient } from '@opencode/client';

import { type Host } from './harness.ts';
import { chooseLabel, type OperatorDecision } from './operator.ts';

/** Ответ, который ожидает форма: по одному значению на ключ поля. */
export type FormAnswer = Record<string, string | number | boolean | Array<string>>;

export interface V2SmokeClient {
  createSession(title: string): Promise<string>;
  /**
   * Отправить одну инструкцию и выполнять оператора, пока сессия не завершится.
   *
   * Выбрасывает `PromptTimeoutError`, когда хост превышает бюджет промпта
   * (`HOST_SMOKE_PROMPT_TIMEOUT_MS`, по умолчанию 60 с): промпт, который никогда
   * не завершается, — это находка о хосте, поэтому сценарий сообщает о нём, а не
   * повторяет попытку или ждёт бесконечно.
   */
  prompt(sessionId: string, text: string, decision?: OperatorDecision): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  /** Ответы на вопросы, которые сценарий не задавал, по порядку. */
  offScript(): string[];
}

export type V2SmokeTransport = typeof fetch;

/**
 * Как долго может выполняться один промпт, прежде чем клиент сочтёт его находкой.
 *
 * Живая модель медленная, не зависшая; на этом хосте одна инструкция с вызовом
 * инструментов провела ~32 с внутри `session.wait` и завершилась. Бюджет должен
 * быть всего в несколько раз больше, потому что его задача — превратить
 * неограниченное ожидание в сообщаемую ошибку, а не засекать время модели.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;

/** Определить бюджет промпта; непригодное значение откатывается к умолчанию. */
export function promptTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HOST_SMOKE_PROMPT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROMPT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROMPT_TIMEOUT_MS;
}

/**
 * Промпт, превысивший свой бюджет.
 *
 * Клиент не может отличить медленную модель от зависшего хоста, поэтому когда
 * бюджет исчерпан, он прекращает ожидание и передаёт сценарию находку для
 * сообщения, а не зависает. Сообщение содержит то, чего всё ещё ждал хост,
 * потому что это единственное свидетельство, оставшееся после отказа от вызова.
 */
export class PromptTimeoutError extends Error {
  constructor(operation: string, budgetMs: number, detail: string) {
    super(`[ERROR] ${operation} did not settle within ${budgetMs}ms: ${detail}`);
    this.name = 'PromptTimeoutError';
  }
}

/**
 * Хост V2 игнорирует унаследованный `OPENCODE_SERVER_PASSWORD`: он генерирует
 * собственные учётные данные и требует их при каждом вызове `/api`. Без этого
 * заголовка сервер отвечает 401 с пустым телом, и сгенерированный клиент
 * сообщает об этом как `UnsupportedContentType` — ошибка авторизации
 * в костюме content-type.
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

/** Всё, что содержит форма, чтобы тег consent можно было найти, где бы он ни оказался. */
function formText(form: Pick<FormInfo, 'title' | 'fields'>): string {
  return [form.title, ...form.fields.flatMap((field) => [field.title, field.description])]
    .filter(Boolean)
    .join(' ');
}

export interface FormAnswerPlan {
  answer: FormAnswer;
  /** Ответы, которые не соответствовали тому, что запрашивала инструкция, и почему. */
  offScript: string[];
}

/**
 * Что оператор отвечает на одну форму.
 *
 * Запрос согласия плагина приходит в V2 как форма, а тег, сообщающий об этом,
 * копируется в текст вопроса — поэтому именно тег, где бы он ни оказался,
 * делает это собственным предметом сценария, а не вопросом, придуманным моделью.
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
      // Свободный текст. Оператору нечего добавить к инструкции от себя,
      // поэтому собственное значение поля по умолчанию — это честный ответ.
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
  /** Как долго может выполняться один промпт; по умолчанию `HOST_SMOKE_PROMPT_TIMEOUT_MS`. */
  promptTimeoutMs?: number;
  /**
   * Агент, под которым выполняется сессия.
   *
   * V1 отправляет `agent` с каждым сообщением, а стадии smoke-профиля разрешают
   * только `orchestrator`: сессия, оставленная на умолчании хоста (`build`),
   * отклоняется собственными правилами workflow (`Refused workflow-tasks-set … allowed:
   * ["orchestrator"]`), и её ход продолжается, вместо того чтобы
   * остановиться на инструкции.
   */
  agent?: string;
}

/** Что показал один обход: сколько форм было отвечено. */
interface SweepResult {
  answered: number;
}

export function createV2SmokeClient(host: Host, options: V2SmokeClientOptions = {}): V2SmokeClient {
  const transport = createV2SmokeTransport(host.authHeader);
  const client = OpenCode.make({ baseUrl: host.url, fetch: transport });
  // Один клиент управляет одной сессией сценария, поэтому запись о том, что уже
  // было отвечено, переживает один промпт: форма, отвеченная в раннем промпте,
  // никогда не отвечается дважды.
  const seen = new Set<string>();
  const notes: string[] = [];
  // Чего хост, по его последнему сообщению, ждал. Записывается до ответов,
  // чтобы ответ, который хост так и не получил, всё равно появился в сообщении о тайм-ауте.
  let waitingForms = 0;

  /** Ответить на всё, чего ждёт хост, и сообщить, что осталось. */
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
        // Оставляем отвечаемой: форма, отменённая хостом во время ответа, не должна
        // скрывать ту, которая всё ещё ждёт.
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
       * Выполнить один вызов хоста в рамках бюджета промпта. Вызов, превышающий
       * его, — это находка: саму проверку нельзя переждать, но
       * прерванный вызов сохраняет всё, что уже сообщил нам.
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
        // Остановиться на дедлайне: обход, превысивший бюджет, скрыл бы его.
        while (!stopped && Date.now() < deadline) {
          try {
            await bound('form sweep', sweep(sessionId, decision));
          } catch {
            // Сервер занят или бюджет исчерпан; промпт сообщит об этом.
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      })();

      try {
        await bound('session.prompt', client.session.prompt({ sessionID: sessionId, text }));
        await bound('session.wait', client.session.wait({ sessionID: sessionId }));
        // Ответ меняет то, что делает остальная часть промпта, поэтому всё, что
        // всё ещё ждёт, отвечается и ожидается снова.
        for (let round = 0; round < 5; round += 1) {
          const swept = await bound('form sweep', sweep(sessionId, decision));
          if (swept.answered === 0) break;
          await bound('session.wait', client.session.wait({ sessionID: sessionId }));
        }
      } finally {
        stopped = true;
        // Обходчик должен остановиться, а не завершиться: обход, всё ещё выполняющийся,
        // иначе удерживал бы промпт, который уже завершился, на остаток
        // бюджета. Запоздалая форма покрывается раундами выше, а не этим циклом.
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
