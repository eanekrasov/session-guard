import { describe, expect, it, vi } from 'vitest';
import { createWorkflowLifecycle } from '../../src/app/workflow-lifecycle.ts';
import { createSession } from '../../src/session/session-store.ts';
import type { SessionTransaction } from '../../src/app/session-executor.ts';

describe('workflow lifecycle', () => {
  it('records a terminal outcome and defers archive until after save', async () => {
    const session = createSession('session-1', 'profile', 'schema', 'working');
    const archive = vi.fn(async () => '/archive/session-1.json');
    const lifecycle = createWorkflowLifecycle({
      projectDir: '/tmp/test-project',
      mutationOrchestrator: {
        applyTransitions: vi.fn(async () => {
          session.currentStage = 'done';
          return {
            applied: true,
            from: 'working',
            to: 'done',
            guard: 'all checks passed',
          };
        }),
        resolveEngine: vi.fn(async () => ({
          isTerminalStage: (stage: string) => stage === 'done',
        })) as never,
        clearOnError: vi.fn(async () => undefined),
        dispose: vi.fn(),
      },
      store: { archive, list: vi.fn(async () => []), load: vi.fn(async () => null) },
      executor: {
        run: vi.fn(
          async (_sessionID: string, _action: (tx: SessionTransaction) => Promise<unknown>) =>
            undefined
        ) as never,
      },
      log: vi.fn(async () => undefined),
    });
    const deferred: Array<() => Promise<void>> = [];

    await lifecycle.afterTool(session, {
      deferAfterSave: (callback: () => Promise<void>) => deferred.push(callback),
    } satisfies Pick<SessionTransaction, 'deferAfterSave'>);

    expect(session.outcome).toMatchObject({
      stage: 'done',
      from: 'working',
      guard: 'all checks passed',
      failedGates: [],
      exhaustedBudgets: [],
    });
    expect(archive).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    await deferred[0]!();

    expect(archive).toHaveBeenCalledWith('session-1');
  });

  it('continues the host-error sweep when one session cannot be read', async () => {
    const session = createSession('session-2', 'profile', 'schema', 'working');
    session.activeOperations['call-2'] = {
      callId: 'call-2',
      status: 'running',
      agent: 'orchestrator',
      kind: 'mutation',
      round: 1,
      startedAt: new Date().toISOString(),
    };
    const run = vi.fn(
      async (_sessionID: string, action: (tx: SessionTransaction) => Promise<unknown>) =>
        action({ session, deferAfterSave: () => undefined })
    ) as never;
    const lifecycle = createWorkflowLifecycle({
      projectDir: '/tmp/test-project',
      mutationOrchestrator: {
        applyTransitions: vi.fn(async () => ({ applied: false })),
        resolveEngine: vi.fn(async () => ({ isTerminalStage: () => false })) as never,
        clearOnError: vi.fn(async () => undefined),
        dispose: vi.fn(),
      },
      store: {
        archive: vi.fn(async () => null),
        list: vi.fn(async () => ['broken', 'session-2']),
        load: vi.fn(async (sessionID: string) => {
          if (sessionID === 'broken') throw new Error('unreadable');
          return session;
        }),
      },
      executor: { run },
      log: vi.fn(async () => undefined),
    });

    await lifecycle.handleEvent({
      event: {
        type: 'message.part.updated',
        properties: { part: { callID: 'call-2', state: { status: 'error' } } },
      },
    });

    expect(run).toHaveBeenCalledWith('session-2', expect.any(Function));
    expect(session.activeOperations['call-2']?.status).toBe('interrupted');
  });
});
