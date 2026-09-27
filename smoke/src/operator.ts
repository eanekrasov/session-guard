/**
 * Оператор, которого исполняют оба smoke-прогона.
 *
 * V1 отвечает на tool `question` хоста через HTTP; V2 отвечает на формы хоста.
 * *Что именно решает оператор* — одна политика, поэтому она живёт здесь: две
 * копии «какая опция означает нет» разойдутся, и один прогон начнёт уводить
 * сценарии другого.
 *
 * **Consent-request** — собственный субъект сценария: он получает решение,
 * которое запросила инструкция (по умолчанию grant) — именно то, для записи
 * чего и существует механизм согласия.
 *
 * Всё остальное — вопрос, выдуманный моделью: «How would you like to proceed?».
 * Честный ответ оператора на вопрос, которого никто не задавал, — «не делай
 * ничего сверх инструкции», поэтому предпочтительна опция отказа. Когда модель
 * не предлагает способа отказать, безопасного ответа нет: возвращается первый
 * вариант, а вызывающий код записывает, что так и было.
 */

/**
 * Слова, которыми опция говорит «нет». Упорядочены: выигрывает первое, так что
 * явный отказ перебивает просто негативно звучащую метку.
 */
export const DECLINING_WORDS = [
  'decline',
  'no,',
  'no ',
  'cancel',
  'stop',
  'skip',
  "don't",
  'do not',
] as const;

export type OperatorDecision = 'grant' | 'decline';

export interface LabelChoice {
  /** Метка, которой отвечать. */
  label: string;
  /** Найденная опция отказа, если среди меток была такая. */
  refusal?: string;
}

/** Метка, которую оператор выбирает из предложенных хостом. */
export function chooseLabel(
  labels: string[],
  decision: OperatorDecision,
  consent: boolean
): LabelChoice {
  if (consent) {
    const normalizedDecision = decision.trim().toLowerCase();
    const wanted =
      labels.find((label) => label.trim().toLowerCase() === normalizedDecision) ??
      labels.find((label) => label.toLowerCase().includes(decision));
    return { label: wanted ?? labels[0] ?? decision };
  }

  const refusal = DECLINING_WORDS.reduce<string | undefined>(
    (found, word) => found ?? labels.find((label) => label.toLowerCase().includes(word)),
    undefined
  );
  return { label: refusal ?? labels[0] ?? 'no', ...(refusal ? { refusal } : {}) };
}
