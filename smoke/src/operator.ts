/**
 * The operator both smoke runs play.
 *
 * V1 answers the host's `question` tool over HTTP; V2 answers the host's forms.
 * *What the operator decides* is one policy, so it lives here — two copies of
 * «which option means no» would drift apart and one run would start steering
 * the other's scenarios.
 *
 * A **consent request** is the scenario's own subject: it gets the decision the
 * instruction asked for (default: grant), which is exactly what the consent
 * mechanism exists to record.
 *
 * Anything else is a question the model invented — «How would you like to
 * proceed?» — and the operator's honest answer to a question nobody asked for
 * is «do nothing beyond the instruction», so a declining option is preferred.
 * When the model offers no way to decline there is no safe answer: the first
 * option goes back, and the caller records that it did.
 */

/**
 * Words an option uses to say "no". Ordered: the earlier one wins, so an
 * explicit refusal beats a merely negative-sounding label.
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
  /** The label to answer with. */
  label: string;
  /** The declining option that was found, when the labels offered one. */
  refusal?: string;
}

/** The label the operator picks out of the ones the host offered. */
export function chooseLabel(
  labels: string[],
  decision: OperatorDecision,
  consent: boolean
): LabelChoice {
  if (consent) {
    const wanted = labels.find((label) => label.toLowerCase().includes(decision));
    return { label: wanted ?? labels[0] ?? decision };
  }

  const refusal = DECLINING_WORDS.reduce<string | undefined>(
    (found, word) => found ?? labels.find((label) => label.toLowerCase().includes(word)),
    undefined
  );
  return { label: refusal ?? labels[0] ?? 'no', ...(refusal ? { refusal } : {}) };
}
