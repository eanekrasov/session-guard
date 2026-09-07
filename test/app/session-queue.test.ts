import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { withSession } from '../../test/helpers.ts';
import { createTask } from '../support/task-factory.ts';

// ─── Helpers ──────────────────────────────────────────────────────

let storeDir: string;
let store: WorkflowStore;

beforeEach(() => {
  storeDir = '/tmp/state-machine-test-' + Math.random().toString(36).slice(2);
  store = new WorkflowStore(storeDir);
});

/** Seed a session into the store dir. */
async function seedSession(sessionId: string, profileId = 'test'): Promise<void> {
  const session = createSession(sessionId, profileId, 'cycle');
  await store.save(session);
}

// ─── Shared deferred helper for concurrency tests ──────────────────

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('SessionQueue', () => {
  it('executes a single enqueued action', async () => {
    await seedSession('sq-single');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const result = await queue.enqueue('sq-single', async (session) => {
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('sq-single');
      return 'done';
    });

    expect(result).toBe('done');
  });

  it('chains two enqueues for the same root session (per-root serialization)', async () => {
    await seedSession('sq-chain');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const order: string[] = [];

    const first = queue.enqueue('sq-chain', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('first-end');
      return 1;
    });

    const second = queue.enqueue('sq-chain', async () => {
      order.push('second');
      return 2;
    });

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('isolates concurrent enqueues on different roots', async () => {
    await seedSession('sq-root-a');
    await seedSession('sq-root-b');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const order: string[] = [];
    const gate = deferred();
    // Синхронизатор: A подтверждает что сел на gate, B ждёт этого сигнала
    const aSeated = deferred();

    const aPromise = queue.enqueue('sq-root-a', async () => {
      order.push('a-waits');
      aSeated.resolve();
      await gate.promise;
      order.push('a-done');
      return 'A';
    });

    // Ждём пока A сядет на gate, только потом запускаем B
    await aSeated.promise;

    const bPromise = queue.enqueue('sq-root-b', async () => {
      order.push('b-runs');
      return 'B';
    });

    expect(await bPromise).toBe('B');
    expect(order).toEqual(['a-waits', 'b-runs']);

    gate.resolve();
    expect(await aPromise).toBe('A');
    expect(order).toEqual(['a-waits', 'b-runs', 'a-done']);
  });

  it('chains by resolved root session ID (parent chain)', async () => {
    await seedSession('sq-parent-root');
    await seedSession('sq-parent-child');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    // The chain is the host's; a session file never carries its parent.
    const queue = new SessionQueue(store, undefined, async (id) =>
      id === 'sq-parent-child' ? 'sq-parent-root' : null
    );

    const order: string[] = [];

    const first = queue.enqueue('sq-parent-root', async () => {
      order.push('root-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('root-end');
      return 1;
    });

    const second = queue.enqueue('sq-parent-child', async () => {
      order.push('child');
      return 2;
    });

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(['root-start', 'root-end', 'child']);
  });

  it('propagates errors from action without breaking the chain', async () => {
    await seedSession('sq-error');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const first = queue.enqueue('sq-error', async () => {
      throw new Error('boom');
    });

    await expect(first).rejects.toThrow('boom');

    const second = queue.enqueue('sq-error', async (session) => {
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('sq-error');
      return 'recovered';
    });

    await expect(second).resolves.toBe('recovered');
  });

  it('resolves root to the session itself when it has no parent', async () => {
    await seedSession('sq-leaf');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const result = await queue.enqueue('sq-leaf', async (session, rootId) => {
      expect(rootId).toBe('sq-leaf');
      return rootId;
    });

    expect(result).toBe('sq-leaf');
  });

  it('does not cache a failed parent lookup as a root', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    let attempts = 0;
    const queue = new SessionQueue(store, undefined, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('SDK unavailable');
      return 'sq-parent-root';
    });

    expect(await queue.rootOf('sq-parent-child')).toBe('sq-parent-child');
    expect(await queue.rootOf('sq-parent-child')).toBe('sq-parent-root');
    expect(attempts).toBe(3);
  });

  it('clear() stops future chaining but does not affect in-flight', async () => {
    await seedSession('sq-clear');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const gate = deferred();

    const first = queue.enqueue('sq-clear', async () => {
      await gate.promise;
      return 'first-done';
    });

    queue.clear();

    const second = queue.enqueue('sq-clear', async () => {
      return 'second-done';
    });

    gate.resolve();
    await expect(first).resolves.toBe('first-done');
    await expect(second).resolves.toBe('second-done');
  });
});

describe('reentrant SessionQueue', () => {
  it('enqueue from inside enqueue callback does NOT deadlock', async () => {
    await seedSession('sq-reenter');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const order: number[] = [];

    const result = await queue.enqueue('sq-reenter', async (session, rootId) => {
      order.push(1);

      // Nested enqueue from inside the callback
      const inner = await queue.enqueue('sq-reenter', async () => {
        order.push(2);
        return 'inner-result';
      });

      order.push(3);
      return inner;
    });

    expect(result).toBe('inner-result');
    expect(order).toEqual([1, 2, 3]);
  });

  it('reentrant calls are serialized correctly with multiple levels', async () => {
    await seedSession('sq-reenter-deep');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const order: number[] = [];
    const counter = { value: 0 };

    const result = await queue.enqueue('sq-reenter-deep', async () => {
      order.push(1);
      counter.value++;

      // Level 2
      const l2 = await queue.enqueue('sq-reenter-deep', async () => {
        order.push(2);
        counter.value++;

        // Level 3
        const l3 = await queue.enqueue('sq-reenter-deep', async () => {
          order.push(3);
          counter.value++;
          return counter.value;
        });

        return l3;
      });

      return l2;
    });

    expect(result).toBe(3);
    expect(order).toEqual([1, 2, 3]);
  });

  it('nested enqueue returns the correct result', async () => {
    await seedSession('sq-reenter-result');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const outerResult = await queue.enqueue('sq-reenter-result', async () => {
      const inner = await queue.enqueue('sq-reenter-result', async () => {
        return 42;
      });
      return inner * 2;
    });

    expect(outerResult).toBe(84);
  });

  it('reentrant enqueue does not create separate promise chain', async () => {
    await seedSession('sq-reenter-chain');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    let enqueueCount = 0;
    const originalEnqueue = queue.enqueue.bind(queue);
    // We can't easily spy on internal chain creation.
    // Instead verify that reentrant calls don't deadlock and execute in order.

    const order: number[] = [];

    // A non-reentrant enqueue followed by a reentrant one
    const p1 = queue.enqueue('sq-reenter-chain', async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
    });

    // This enqueue will wait for p1 in the chain
    // But inside, it's reentrant
    const p2 = queue.enqueue('sq-reenter-chain', async () => {
      order.push(3);

      // Reentrant — should execute inline, not create a new chain link
      await queue.enqueue('sq-reenter-chain', async () => {
        order.push(4);
      });

      order.push(5);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('SessionQueue — writes survive nesting and overlap', () => {
  it('a reentrant write is not overwritten by the outer save', async () => {
    // Reproduces the production failure the host smoke run surfaced: a tool
    // reported "Stored 1 task(s)" while the persisted session held none.
    await seedSession('sq-nested-write');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    await queue.enqueue('sq-nested-write', async (outer) => {
      outer!.currentStage = 'code';
      await queue.enqueue('sq-nested-write', async (inner) => {
        inner!.tasks.implementation = [createTask({ id: 'task-0', status: 'pending' })] as never;
      });
    });

    const persisted = await store.load('sq-nested-write');
    expect(persisted?.tasks.implementation).toHaveLength(1);
    expect(persisted?.currentStage).toBe('code');
  });

  it("a reentrant call sees the outer execution's session, not a reload", async () => {
    await seedSession('sq-nested-identity');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    let sameInstance = false;
    await queue.enqueue('sq-nested-identity', async (outer) => {
      await queue.enqueue('sq-nested-identity', async (inner) => {
        sameInstance = inner === outer;
      });
    });

    expect(sameInstance).toBe(true);
  });

  it('two overlapping top-level calls serialise instead of running inline', async () => {
    // Overlapping in time is not reentrancy. Before this was decided by call
    // context, a second top-level call landed on the inline path and both
    // executions raced on the same root.
    await seedSession('sq-overlap');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

    const started = deferred();
    const release = deferred();
    const order: string[] = [];

    const first = queue.enqueue('sq-overlap', async (session) => {
      order.push('first:start');
      started.resolve();
      await release.promise;
      session!.tasks.implementation = [createTask({ id: 'task-0', status: 'pending' })] as never;
      order.push('first:end');
    });

    await started.promise;
    const second = queue.enqueue('sq-overlap', async (session) => {
      order.push('second:start');
      // Must observe the first execution's persisted write.
      expect(session!.tasks.implementation).toHaveLength(1);
      session!.currentStage = 'review';
      order.push('second:end');
    });

    release.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    const persisted = await store.load('sq-overlap');
    expect(persisted?.currentStage).toBe('review');
    expect(persisted?.tasks.implementation).toHaveLength(1);
  });
});

describe('withSession', () => {
  it('returns null when session does not exist', async () => {
    const result = await withSession(store, 'nonexistent', async () => {
      return 'should-not-run';
    });

    expect(result).toBeNull();
  });

  it('executes action and returns result when session exists', async () => {
    await seedSession('ws-exists');

    const result = await withSession(store, 'ws-exists', async (session) => {
      expect(session.sessionId).toBe('ws-exists');
      return 'ran';
    });

    expect(result).toBe('ran');
  });

  it('does not call action when session is missing', async () => {
    const actionCaller = { called: false };
    await withSession(store, 'ws-no-call', () => {
      actionCaller.called = true;
      return null;
    });

    expect(actionCaller.called).toBe(false);
  });
});

describe('SessionQueue root resolution through the host', () => {
  it('runs a child session action on the parent workflow session', async () => {
    // `parentID` lives on the host's session record, never in a workflow
    // session file — so before the host was asked, this resolution was
    // identity and a dispatched subagent's writes never reached the parent's
    // task scope, invariants or queue.
    await seedSession('sq-root');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const asked: string[] = [];
    const chain: Record<string, string> = { 'sq-child': 'sq-mid', 'sq-mid': 'sq-root' };
    const queue = new SessionQueue(store, undefined, async (id) => {
      asked.push(id);
      return chain[id] ?? null;
    });

    const seen = await queue.enqueue('sq-child', async (session, root) => {
      expect(root).toBe('sq-root');
      return session?.sessionId ?? null;
    });

    expect(seen).toBe('sq-root');
    // Every hop is the host's answer — including the root, which reports no
    // parent of its own. A save seeds nothing into the cache.
    expect(asked).toEqual(['sq-child', 'sq-mid', 'sq-root']);

    // Every node walked is memoised to the root: a second call asks nothing.
    asked.length = 0;
    await queue.enqueue('sq-child', async (_session, root) => expect(root).toBe('sq-root'));
    expect(asked).toEqual([]);
  });

  it('leaves a session as its own root when the host cannot answer', async () => {
    await seedSession('sq-orphan');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store, undefined, async () => {
      throw new Error('host unreachable');
    });

    const seen = await queue.enqueue('sq-orphan', async (session, root) => {
      expect(root).toBe('sq-orphan');
      return session?.sessionId ?? null;
    });

    expect(seen).toBe('sq-orphan');
  });
});
