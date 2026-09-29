import { OpenCode, type FormField, type FormInfo } from '@opencode/client';
import { realpath } from 'node:fs/promises';

import { type Host } from './harness.ts';
import { log } from './log.ts';
import { chooseLabel, type OperatorDecision } from './operator.ts';

/** Ответ, который ожидает форма: по одному значению на ключ поля. */
export type FormAnswer = Record<string, string | number | boolean | Array<string>>;

export interface V2SmokeClient {
  createSession(title: string): Promise<string>; /**
   * Отправить одну инструкцию и выполнять оператора, пока сессия не завершится.
   *
   * Выбрасывает `PromptTimeoutError`, когда хост превышает бюджет промпта
   * (`HOST_SMOKE_PROMPT_TIMEOUT_MS`, по умолчанию 60 с): промпт, который никогда
   * не завершается, — это находка о хосте, поэтому сценарий сообщает о нём, а не
   * повторяет попытку или ждёт бесконечно.
   */
  prompt(
    sessionId: string,
    text: string,
    decision?: OperatorDecision,
    /** Предел на этот промпт, когда шаг объявляет свой. */
    budgetOverrideMs?: number
  ): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  /**
   * Raw messages of the session, as the generated client reports them. The transport
   * narrows them into the shared turn parts; this client never interprets them.
   */
  listMessages(sessionId: string): Promise<unknown[]>;
  /**
   * Switch the agent this session runs as. V2 carries the agent on the session, so a step that
   * must run as another agent — a worker the task guard refuses — needs this between prompts.
   */
  switchAgent(sessionId: string, agent: string): Promise<void>;
  /** Forms this client answered, in the order it answered them. */
  answeredForms(): AnsweredForm[];
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
  /** Forms the host was still waiting on when the budget ran out; 0 when it awaited none. */
  readonly pendingForms: number;

  constructor(operation: string, budgetMs: number, detail: string, pendingForms = 0) {
    super(`[ERROR] ${operation} не завершился за ${budgetMs} мс: ${detail}`);
    this.name = 'PromptTimeoutError';
    this.pendingForms = pendingForms;
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
  /** Несёт ли форма собственный тег согласия плагина (`<consent-request …>`). */
  consent: boolean;
  /**
   * Какие варианты выбраны по каждому полю: метки, предложенные хостом, и решение оператора.
   * Нужны, чтобы caller мог отчитаться, какой именно ответ ушёл хосту, не разбирая payload.
   */
  choices: Array<{ key: string; decision: OperatorDecision; label: string; offered: string[] }>;
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
  const choices: FormAnswerPlan['choices'] = [];

  for (const field of form.fields) {
    const label = field.title ?? field.key;
    const options = optionsOf(field);
    if (options) {
      const offered = options.map((option) => option.label);
      const choice = chooseLabel(offered, decision, consent);
      const option = options.find((candidate) => candidate.label === choice.label);
      if (!option) {
        offScript.push(`no option matched for "${label}"`);
        continue;
      }
      choices.push({ key: field.key, decision, label: choice.label, offered });
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

  return { answer, offScript, consent, choices };
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

/** Одна форма, на которую оператор ответил: что ушло хосту. */
export interface AnsweredForm {
  id: string;
  /** Несёт ли форма тег согласия плагина. */
  consent: boolean;
  decision: OperatorDecision;
  /** Метка, выбранная из предложенных хостом. */
  label: string;
  offered: string[];
}

export function createV2SmokeClient(host: Host, options: V2SmokeClientOptions = {}): V2SmokeClient {
  const transport = createV2SmokeTransport(host.authHeader);
  const client = OpenCode.make({ baseUrl: host.url, fetch: transport });
  // Один клиент управляет одной сессией сценария, поэтому запись о том, что уже
  // было отвечено, переживает один промпт: форма, отвеченная в раннем промпте,
  // никогда не отвечается дважды.
  const seen = new Set<string>();
  const pending = new Set<string>();
  const allowedSessions = new Set<string>();
  const notes: string[] = [];
  // Чего хост, по его последнему сообщению, ждал. Записывается до ответов,
  // чтобы ответ, который хост так и не получил, всё равно появился в сообщении о тайм-ауте.
  let waitingForms = 0;
  // Что именно оператор ответил: форма, решение и выбранная метка.
  const answeredForms: AnsweredForm[] = [];

  async function answerForm(form: FormInfo, decision: OperatorDecision): Promise<void> {
    if (seen.has(form.id)) return;
    seen.add(form.id);
    pending.add(form.id);
    waitingForms = pending.size;
    const plan = planFormAnswer(form, decision);
    notes.push(...plan.offScript);
    try {
      await client.session.form.reply({
        sessionID: form.sessionID,
        formID: form.id,
        answer: plan.answer,
      });
      // Report the form and the choice behind each field, so the caller can say what was sent
      // without knowing anything about the form's own shape.
      for (const choice of plan.choices) {
        answeredForms.push({
          id: form.id,
          consent: plan.consent,
          decision: choice.decision,
          label: choice.label,
          offered: choice.offered,
        });
      }
      for (const choice of plan.choices) {
        log('debug', 'operator interaction answered', {
          type: 'interaction.answer',
          fields: {
            kind: 'form',
            id: form.id,
            isConsent: plan.consent,
            decision: choice.decision,
            label: choice.label,
            offered: choice.offered,
            key: choice.key,
          },
        });
      }
    } catch (error) {
      // Оставляем отвечаемой: форма, отменённая хостом во время ответа, не должна
      // скрывать ту, которая всё ещё ждёт.
      seen.delete(form.id);
      pending.delete(form.id);
      notes.push(
        `не удалось ответить на форму ${form.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function listenForms(decision: OperatorDecision, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of client.event.subscribe({ signal })) {
        // Keep the raw SSE stream visible before any session filtering. This is intentionally
        // broader than form handling: unrelated sessions and host lifecycle events are useful
        // when diagnosing a prompt that never reaches model execution.
        const serialized = (() => {
          try {
            return JSON.stringify(event);
          } catch {
            return String(event);
          }
        })();
        log('trace', `V2 SSE event: ${serialized}`, {
          type: 'sse.event',
          fields: { event },
        });
        if (event.type === 'session.created') {
          if (
            typeof event.data.parentID === 'string' &&
            allowedSessions.has(event.data.parentID) &&
            typeof event.data.sessionID === 'string'
          ) {
            allowedSessions.add(event.data.sessionID);
          }
          continue;
        }
        if (event.type === 'form.created' && allowedSessions.has(event.data.form.sessionID)) {
          await answerForm(event.data.form, decision);
          continue;
        }
        if (
          (event.type === 'form.replied' || event.type === 'form.cancelled') &&
          allowedSessions.has(event.data.sessionID)
        ) {
          pending.delete(event.data.id);
          waitingForms = pending.size;
        }
      }
    } catch {
      // The prompt reports the failure; this listener must not reject its caller.
    }
  }

  return {
    async createSession(title: string): Promise<string> {
      // OpenCode resolves the Git worktree through realpath before Snapshot compares it with
      // the session location. macOS commonly exposes the temporary directory through /var,
      // while realpath returns /private/var; use one canonical spelling for both sides.
      let directory = host.workDir;
      try {
        directory = await realpath(host.workDir);
      } catch {
        // Test transports may intentionally use a symbolic, non-existent work directory.
        // A live host still gets the canonical path; the fallback preserves the client request.
      }
      const session = await client.session.create({
        title,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        location: { directory },
      });
      return session.id;
    },

    async prompt(
      sessionId: string,
      text: string,
      decision: OperatorDecision = 'grant',
      budgetOverrideMs?: number
    ): Promise<void> {
      // Шаг может объявить свой предел: длинный шаг pipeline законно идёт дольше общего
      // бюджета клиента, и общий бюджет обрывал бы его на нормальном для него времени.
      const budgetMs = budgetOverrideMs ?? options.promptTimeoutMs ?? promptTimeoutMs();
      const deadline = Date.now() + budgetMs;

      const pendingNote = (): string =>
        waitingForms > 0
          ? `хост всё ещё ожидает ${waitingForms} форм`
          : 'у хоста нет ожидающей формы';

      /**
       * Выполнить один вызов хоста в рамках бюджета промпта. Вызов, превышающий
       * его, — это находка: саму проверку нельзя переждать, но
       * прерванный вызов сохраняет всё, что уже сообщил нам.
       */
      const bound = async <T>(operation: string, work: Promise<T>): Promise<T> => {
        const left = deadline - Date.now();
        if (left <= 0)
          throw new PromptTimeoutError(operation, budgetMs, pendingNote(), waitingForms);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new PromptTimeoutError(operation, budgetMs, pendingNote(), waitingForms)),
                left
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      const events = new AbortController();
      allowedSessions.add(sessionId);
      const listener = listenForms(decision, events.signal);

      try {
        await bound('session.prompt', client.session.prompt({ sessionID: sessionId, text }));
        await bound('session.wait', client.session.wait({ sessionID: sessionId }));
      } finally {
        events.abort();
        await Promise.race([listener, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      }
    },

    async removeSession(sessionId: string): Promise<void> {
      await client.session.remove({ sessionID: sessionId });
    },

    async listMessages(sessionId: string): Promise<unknown[]> {
      const response = await client.message.list({ sessionID: sessionId });
      return response?.data ?? [];
    },

    async switchAgent(sessionId: string, agent: string): Promise<void> {
      await client.session.switchAgent({ sessionID: sessionId, agent });
    },

    answeredForms: () => [...answeredForms],

    offScript: () => [...notes],
  };
}
