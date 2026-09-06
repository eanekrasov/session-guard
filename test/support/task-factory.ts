import type { MutationTask } from '../../src/session/session-schema.ts';

/**
 * Build one `MutationTask` for tests. Returns the inferred `MutationTask`
 * type, so a schema change breaks compilation at every call site in one
 * place instead of at 52 scattered literals (see design.md D6).
 */
export const createTask = (overrides: Partial<MutationTask> = {}): MutationTask => ({
  id: 'task-1',
  status: 'pending',
  ...overrides,
});

/**
 * Build several `MutationTask`s. Each override object may set its own `id`;
 * otherwise tasks are numbered `task-1`, `task-2`, ... in order.
 */
export const createTasks = (...overrides: Array<Partial<MutationTask>>): MutationTask[] =>
  overrides.map((o, i) => createTask({ id: `task-${i + 1}`, ...o }));
