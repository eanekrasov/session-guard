import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { WorkflowStore } from '../../src/session/session-store.ts';
import type { LogFn } from '../../src/app/logger.ts';
import type { ResolveParentFn } from '../../src/app/session-executor.ts';

// ─── Mock store ───────────────────────────────────────────────────────────────

function mockStore(): {
  store: WorkflowStore;
  loadCalls: Array<string>;
  saveCalls: Array<WorkflowSession>;
  setLoadResult: (_session: WorkflowSession | null) => void;
  setSaveError: (_err: Error) => void;
} {
  const loadCalls: Array<string> = [];
  const saveCalls: Array<WorkflowSession> = [];
  let loadResult: WorkflowSession | null = null;
  let loadError: Error | null = null;
  let saveError: Error | null = null;

  const store = {
    load: vi.fn(async (id: string) => {
      loadCalls.push(id);
      if (loadError) throw loadError;
      return loadResult;
    }),
    save: vi.fn(async (sess: WorkflowSession) => {
      if (saveError) throw saveError;
      saveCalls.push(sess);
    }),
    onSave: new Set<() => void>(),
  } as unknown as WorkflowStore;

  return {
    store,
    loadCalls,
    saveCalls,
    setLoadResult(session: WorkflowSession | null) {
      loadResult = session;
    },
    setSaveError(err: Error) {
      saveError = err;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(sessionId: string, overrides?: Partial<WorkflowSession>): WorkflowSession {
  return {
    schemaVersion: 1,
    sessionId,
    profileId: 'test',
    schemaId: 'cycle',
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
    currentStage: 'planning',
    invariantViolations: [],
    consentedCallIDs: [],
    processedResultCallIDs: [],
    ...overrides,
  };
}

function noopLog(): LogFn {
  return async () => {};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run() — full lifecycle', () => {
    it('loads, runs action, compares snapshot, and saves on mutation', async () => {
      const { store, loadCalls, saveCalls, setLoadResult } = mockStore();
      const session = makeSession('se-mutate', { currentStage: 'planning' });
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      const result = await executor.run('se-mutate', async (tx) => {
        expect(tx.session).toBe(session);
        expect(tx.session!.currentStage).toBe('planning');
        tx.session!.currentStage = 'code';
        return 'mutated';
      });

      expect(result).toBe('mutated');
      expect(loadCalls).toEqual(['se-mutate']);
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0].sessionId).toBe('se-mutate');
      expect(saveCalls[0].currentStage).toBe('code');
    });

    it('skips save on read-only action (no mutation)', async () => {
      const { store, loadCalls, saveCalls, setLoadResult } = mockStore();
      const session = makeSession('se-readonly');
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      const result = await executor.run('se-readonly', async (tx) => {
        // Only read from the session, no mutation
        return tx.session!.currentStage;
      });

      expect(result).toBe('planning');
      expect(loadCalls).toHaveLength(1);
      expect(saveCalls).toHaveLength(0);
    });

    it('returns the action result', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('se-return');
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      const result = await executor.run('se-return', async () => 42);
      expect(result).toBe(42);
    });
  });

  describe('run() — session not found (null)', () => {
    it('invokes action with null session when no workflow session exists', async () => {
      const { store, loadCalls, saveCalls, setLoadResult } = mockStore();
      setLoadResult(null);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      let seenTx: unknown = null;
      const result = await executor.run('se-null', async (tx) => {
        seenTx = tx;
        expect(tx.session).toBeNull();
        return 'no-session';
      });

      expect(result).toBe('no-session');
      expect(loadCalls).toHaveLength(1);
      // No session to save — and null didn't become non-null
      expect(saveCalls).toHaveLength(0);
      expect((seenTx as { session: unknown })!.session).toBeNull();
    });
  });

  describe('deferAfterSave', () => {
    it('runs deferred effects after a successful save', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('se-defer');
      setLoadResult(session);

      const order: string[] = [];

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      await executor.run('se-defer', async (tx) => {
        tx.session!.currentStage = 'review';
        tx.deferAfterSave(async () => {
          order.push('deferred-1');
        });
        tx.deferAfterSave(async () => {
          order.push('deferred-2');
        });
      });

      expect(order).toEqual(['deferred-1', 'deferred-2']);
    });

    it('does NOT run deferred effects when session was not mutated', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('se-defer-nosave');
      setLoadResult(session);

      const deferredRan: boolean[] = [];

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      await executor.run('se-defer-nosave', async (tx) => {
        tx.deferAfterSave(async () => {
          deferredRan.push(true);
        });
        // No mutation — save is skipped
      });

      expect(deferredRan).toHaveLength(0);
    });

    it('does NOT run deferred effects when save fails', async () => {
      const { store, setLoadResult, setSaveError } = mockStore();
      const session = makeSession('se-defer-fail');
      setLoadResult(session);
      setSaveError(new Error('disk full'));

      const deferredRan: boolean[] = [];

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      await expect(
        executor.run('se-defer-fail', async (tx) => {
          tx.session!.currentStage = 'review';
          tx.deferAfterSave(async () => {
            deferredRan.push(true);
          });
        })
      ).rejects.toThrow('disk full');

      expect(deferredRan).toHaveLength(0);
    });
  });

  describe('error propagation', () => {
    it('propagates load failure, no action runs', async () => {
      const { store, loadCalls } = mockStore();

      let actionCalled = false;

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      // Make the mock store throw on load
      store.load = vi.fn(async () => {
        throw new Error('load failed');
      }) as typeof store.load;

      await expect(
        executor.run('se-loadfail', async () => {
          actionCalled = true;
        })
      ).rejects.toThrow('load failed');

      expect(actionCalled).toBe(false);
    });

    it('propagates action failure and does NOT save', async () => {
      const { store, saveCalls, setLoadResult } = mockStore();
      const session = makeSession('se-actionfail');
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      await expect(
        executor.run('se-actionfail', async () => {
          throw new Error('action boom');
        })
      ).rejects.toThrow('action boom');

      expect(saveCalls).toHaveLength(0);
    });

    it('propagates save failure', async () => {
      const { store, setLoadResult, setSaveError } = mockStore();
      const session = makeSession('se-savefail');
      setLoadResult(session);
      setSaveError(new Error('save failed'));

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      await expect(
        executor.run('se-savefail', async (tx) => {
          tx.session!.currentStage = 'code';
        })
      ).rejects.toThrow('save failed');
    });

    it('finally does NOT mask errors (no return value in finally)', async () => {
      const { store } = mockStore();

      // Make the mock store throw on load
      store.load = vi.fn(async () => {
        throw new Error('epic fail');
      }) as typeof store.load;

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      await expect(executor.run('se-nomask', async () => 'ok')).rejects.toThrow('epic fail');
    });
  });

  describe('error recovery — chain does not break', () => {
    it('continues to execute subsequent calls after an error', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('se-chain-recover');
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      // First call fails
      const first = executor.run('se-chain-recover', async () => {
        throw new Error('first fail');
      });
      await expect(first).rejects.toThrow('first fail');

      // Second call for the same root succeeds — reset load result
      setLoadResult(session);
      const second = await executor.run('se-chain-recover', async (tx) => {
        tx.session!.currentStage = 'code';
        return 'recovered';
      });

      expect(second).toBe('recovered');
    });
  });

  describe('reentrancy via ALS', () => {
    it('nested run() for the same root is reentrant — no I/O', async () => {
      const { store, loadCalls, saveCalls, setLoadResult } = mockStore();
      const session = makeSession('se-reenter', { currentStage: 'planning' });
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      const order: number[] = [];

      const result = await executor.run('se-reenter', async (tx) => {
        order.push(1);
        tx.session!.currentStage = 'code';

        // Nested call — same root, reentrant via ALS
        const inner = await executor.run('se-reenter', async (innerTx) => {
          order.push(2);
          // Must see the same session object (same mutation in progress)
          expect(innerTx.session).toBe(tx.session);
          innerTx.session!.title = 'nested-wrote';
          return 'inner';
        });

        order.push(3);
        return inner;
      });

      expect(result).toBe('inner');
      expect(order).toEqual([1, 2, 3]);
      // Only one load, one save — the outer transaction
      expect(loadCalls).toHaveLength(1);
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0].currentStage).toBe('code');
      expect(saveCalls[0].title).toBe('nested-wrote');
    });

    it('reentrant with multiple nesting levels', async () => {
      const { store, loadCalls, saveCalls, setLoadResult } = mockStore();
      const session = makeSession('se-reenter-deep');
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      const order: number[] = [];

      await executor.run('se-reenter-deep', async () => {
        order.push(1);

        await executor.run('se-reenter-deep', async () => {
          order.push(2);

          await executor.run('se-reenter-deep', async () => {
            order.push(3);
          });

          order.push(4);
        });

        order.push(5);
      });

      expect(order).toEqual([1, 2, 3, 4, 5]);
      expect(loadCalls).toHaveLength(1);
      expect(saveCalls).toHaveLength(0); // no mutation → no save
    });
  });

  describe('root resolution', () => {
    it('resolves root through parent chain', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('parent-root');
      setLoadResult(session);

      const asked: string[] = [];
      const chain: Record<string, string> = { child: 'mid', mid: 'parent-root' };

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog(), async (id) => {
        asked.push(id);
        return chain[id] ?? null;
      });

      // Child resolves through the chain to parent-root
      await executor.run('child', async (tx) => {
        expect(tx.session?.sessionId).toBe('parent-root');
      });

      expect(asked).toEqual(['child', 'mid', 'parent-root']);
    });

    it('caches resolved parent chain — second call does not ask host again', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('cached-root');
      setLoadResult(session);

      let hostCalls = 0;

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog(), async (id) => {
        hostCalls++;
        return id === 'cached-child' ? 'cached-root' : null;
      });

      // First call resolves and caches
      await executor.run('cached-child', async () => {});
      expect(hostCalls).toBeGreaterThanOrEqual(1);

      // Second call should use cache
      const prev = hostCalls;
      await executor.rootOf('cached-child');
      expect(hostCalls).toBe(prev); // no new host calls
    });
  });

  describe('clear()', () => {
    it('clears pending queues but does not affect in-flight calls', async () => {
      const { store, setLoadResult } = mockStore();
      const session = makeSession('se-clear');
      setLoadResult(session);

      const { SessionExecutor } = await import('../../src/app/session-executor.ts');
      const executor = new SessionExecutor(store, noopLog());

      // Use a deferred gate to keep the first call in-flight
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const first = executor.run('se-clear', async () => {
        await gate;
        return 'first-done';
      });

      executor.clear();

      const second = executor.run('se-clear', async () => {
        return 'second-done';
      });

      release!();
      await expect(first).resolves.toBe('first-done');
      await expect(second).resolves.toBe('second-done');
    });
  });
});
