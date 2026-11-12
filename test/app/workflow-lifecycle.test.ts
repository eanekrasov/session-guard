import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowLifecycle } from '../../src/app/workflow-lifecycle.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { SessionExecutor, SessionTransaction } from '../../src/app/session-executor.ts';

describe('workflow lifecycle', () => {
  it('does not archive when another store changes the stage before archive', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lifecycle-archive-race-'));
    try {
      const store = new WorkflowStore(directory);
      const other = new WorkflowStore(directory);
      const session = createSession('race', 'profile', 'schema', 'working');
      await store.save(session);
      const originalArchive = store.archive.bind(store);
      const archive = vi.spyOn(store, 'archive').mockImplementation(async (...args) => {
        const latest = (await other.load('race'))!;
        latest.currentStage = 'working';
        await other.save(latest);
        return originalArchive(...args);
      });
      const lifecycle = createWorkflowLifecycle({
        store,
        projectDir: directory,
        executor: {
          run: async <T>(
            _sessionID: string,
            _action: (tx: SessionTransaction) => Promise<T>
          ): Promise<T> => {
            throw new Error('Unexpected executor.run call');
          },
        },
        mutationOrchestrator: {
          applyTransitions: vi.fn(async () => {
            session.currentStage = 'done';
            return { applied: true, from: 'working', to: 'done' };
          }),
          resolveEngine: vi.fn(async () => ({
            isTerminalStage: (stage: string) => stage === 'done',
          })),
          clearOnError: vi.fn(async () => undefined),
          dispose: vi.fn(),
        },
        log: vi.fn(async () => undefined),
      });
      const deferred: Array<() => Promise<void>> = [];
      await lifecycle.afterTool(session, { deferAfterSave: (fn) => deferred.push(fn) });
      await store.save(session);
      await deferred[0]!();

      expect(archive).toHaveBeenCalled();
      expect((await store.load('race'))?.currentStage).toBe('working');
      expect(await store.loadArchived('race')).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records a terminal outcome and defers archive until after save', async () => {
    const session = createSession('session-1', 'profile', 'schema', 'working');
    const archive = vi.fn(async () => '/archive/session-1.json');
    const load = vi.fn(async () => session as typeof session | null);
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
        })),
        clearOnError: vi.fn(async () => undefined),
        dispose: vi.fn(),
      },
      store: { archive, list: vi.fn(async () => []), load },
      executor: {
        run: async <T>(_sessionID: string, action: (tx: SessionTransaction) => Promise<T>) =>
          action({ session, deferAfterSave: () => undefined }),
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

    load.mockResolvedValueOnce({ ...session, currentStage: 'working' });
    await deferred[0]!();
    expect(archive).not.toHaveBeenCalled();

    load.mockResolvedValueOnce(null);
    await deferred[0]!();
    expect(archive).not.toHaveBeenCalled();

    await deferred[0]!();

    expect(load).toHaveBeenCalledWith('session-1');
    expect(archive).toHaveBeenCalledWith('session-1', expect.any(Function));
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
    const runCalls: string[] = [];
    const run: SessionExecutor['run'] = async <T>(
      sessionID: string,
      action: (tx: SessionTransaction) => Promise<T>
    ) => {
      runCalls.push(sessionID);
      return action({ session, deferAfterSave: () => undefined });
    };
    const lifecycle = createWorkflowLifecycle({
      projectDir: '/tmp/test-project',
      mutationOrchestrator: {
        applyTransitions: vi.fn(async () => ({ applied: false })),
        resolveEngine: vi.fn(async () => ({ isTerminalStage: () => false })),
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

    expect(runCalls).toContain('session-2');
    expect(session.activeOperations['call-2']?.status).toBe('interrupted');
  });
});
