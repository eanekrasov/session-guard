// ─── Contract Test Helpers ────────────────────────────────────────────────────
//
// Shared factories and utilities for contract tests.
// All factories produce data that satisfies the corresponding schema defaults.

import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { MutationTask } from '../../src/session/session-schema.ts';

/**
 * Required fields with no defaults in WorkflowSessionSchema.
 */
export const MINIMAL_SESSION_FIELDS = {
  sessionId: 'sessionId',
  profileId: 'profileId',
  schemaId: 'schemaId',
  currentStage: 'currentStage',
} as const satisfies Pick<WorkflowSession, 'sessionId' | 'profileId' | 'schemaId' | 'currentStage'>;

/**
 * Factory for creating valid WorkflowSession instances in tests.
 *
 * Usage:
 *   const session = createTestSession();
 *   const planningSession = createTestSession({ currentStage: 'planning' });
 *   const sessionWithTasks = createTestSession({
 *     tasks: { 'implementation': [{ id: 'task-1', status: 'pending' }] }
 *   });
 *
 * @param overrides - Partial session fields to override defaults
 * @returns A WorkflowSession that satisfies WorkflowSessionSchema.parse()
 */
export function createTestSession(overrides?: Partial<WorkflowSession>): WorkflowSession {
  const base: WorkflowSession = {
    ...MINIMAL_SESSION_FIELDS,
    schemaVersion: 1,
    revision: 0,
    title: '',
    stageGateResults: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    verdictProvenance: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryPermit: null,
    deliveryReceipt: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    changedFiles: [],
    invariantViolations: [],
    consentedCallIDs: [],
    processedResultCallIDs: [],
    ...overrides,
  };

  return base;
}

/**
 * Minimal task factory for tests.
 */
export function makeTask(
  id: string,
  status: MutationTask['status'] = 'pending',
  overrides?: Partial<MutationTask>
): MutationTask {
  return { id, status, ...overrides };
}
