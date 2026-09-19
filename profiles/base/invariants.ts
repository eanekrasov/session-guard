/**
 * Base profile invariants.
 *
 * Базовый набор инвариантов, от которого наследуют все профили.
 * Включает только LF_ONLY — проверку на CRLF-окончания строк.
 */

import type { InvariantCheck } from '../../src/types/index.ts';

export const INVARIANTS: InvariantCheck[] = [
  {
    id: 'LF_ONLY',
    severity: 'error',
    check: (content) => {
      if (content.includes('\r\n')) {
        return '[LF_ONLY] Обнаружены CRLF-окончания строк. Используйте только LF (\\n).';
      }
      return null;
    },
  },
];
