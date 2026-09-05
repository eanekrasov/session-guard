/**
 * Shared types for invariants system.
 * Адаптировано из state-machine/types/invariants.ts.
 *
 * Каждый профиль экспортирует массив INVARIANTS: InvariantCheck[].
 */

export interface InvariantCheck {
  id: string;
  severity: 'error' | 'warning';
  check: (content: string, filePath: string, absolutePath: string) => string | null;
  appliesTo?: (filePath: string) => boolean;
}

export interface InvariantResult {
  errors: InvariantViolation[];
  warnings: InvariantViolation[];
  checked: number;
}

export interface InvariantViolation {
  invariant: string;
  severity: 'error' | 'warning';
  file: string;
  message: string;
  line: number;
}
