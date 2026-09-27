import { describe, expect, test } from 'bun:test';

import { chooseLabel, DECLINING_WORDS } from '../operator.ts';

/**
 * One operator policy for both runs. A consent request gets the decision the
 * instruction asked for; a question the model invented gets the honest answer,
 * which is a declining option when one is offered.
 */

describe('the operator answer policy', () => {
  test('answers a consent request with the requested decision', () => {
    expect(chooseLabel(['grant', 'decline'], 'grant', true).label).toBe('grant');
    expect(chooseLabel(['grant', 'decline'], 'decline', true).label).toBe('decline');
  });

  test('matches the decision inside a longer label', () => {
    expect(chooseLabel(['Grant the plan', 'Decline the plan'], 'grant', true).label).toBe(
      'Grant the plan'
    );
  });

  test('falls back to the first option when a consent offers no matching one', () => {
    expect(chooseLabel(['approve', 'reject'], 'grant', true).label).toBe('approve');
  });

  test('prefers the earliest declining word, not the earliest label', () => {
    // `no,` is earlier in the word list than `stop`, so it wins even though
    // "Stop everything" comes first among the labels.
    const choice = chooseLabel(['Stop everything', 'No, keep going', 'Proceed'], 'grant', false);
    expect(choice.label).toBe('No, keep going');
    expect(choice.refusal).toBe('No, keep going');
  });

  test('records the refusal so the caller can say a refusal was on offer', () => {
    expect(chooseLabel(['yes', 'decline'], 'grant', false).refusal).toBe('decline');
    expect(chooseLabel(['yes', 'later'], 'grant', false)).toEqual({ label: 'yes' });
  });

  test('goes back with the first option when no way to decline is offered', () => {
    const choice = chooseLabel(['Yes, continue', 'Maybe'], 'grant', false);
    expect(choice.label).toBe('Yes, continue');
    expect(choice.refusal).toBeUndefined();
  });

  test('keeps the declining words ordered so an explicit refusal wins', () => {
    expect(DECLINING_WORDS[0]).toBe('decline');
    expect(DECLINING_WORDS).toContain('cancel');
  });
});
