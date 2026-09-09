import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { withSession } from '../../test/helpers.ts';
import { createTask } from '../support/task-factory.ts';

// ─── Helpers ──────────────────────────────────────────────────────

let storeDir: string;
let store: WorkflowStore;

beforeEach(() => {
  storeDir = '/tmp/session-guard-test-' + Math.random().toString(36).slice(2);
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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const result = await queue.enqueue('sq-single', async () => {
      return 'done';
    });

    expect(result).toBe('done');
  });

  it('chains two enqueues for the same root session (per-root serialization)', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const order: string[] = [];
    const gate = deferred();
    const aSeated = deferred();

    const aPromise = queue.enqueue('sq-root-a', async () => {
      order.push('a-waits');
      aSeated.resolve();
      await gate.promise;
      order.push('a-done');
      return 'A';
    });

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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(undefined, async (id) =>
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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const first = queue.enqueue('sq-error', async () => {
      throw new Error('boom');
    });

    await expect(first).rejects.toThrow('boom');

    const second = queue.enqueue('sq-error', async () => {
      return 'recovered';
    });

    await expect(second).resolves.toBe('recovered');
  });

  it('resolves root to the session itself when it has no parent', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    // Use rootOf to verify resolution directly
    const root = await queue.rootOf('sq-leaf');
    expect(root).toBe('sq-leaf');
  });

  it('does not cache a failed parent lookup as a root', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    let attempts = 0;
    const queue = new SessionQueue(undefined, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('SDK unavailable');
      return 'sq-parent-root';
    });

    expect(await queue.rootOf('sq-parent-child')).toBe('sq-parent-child');
    expect(await queue.rootOf('sq-parent-child')).toBe('sq-parent-root');
    expect(attempts).toBe(3);
  });

  it('clear() stops future chaining but does not affect in-flight', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const order: number[] = [];

    const result = await queue.enqueue('sq-reenter', async () => {
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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const order: number[] = [];
    const counter = { value: 0 };

    const result = await queue.enqueue('sq-reenter-deep', async () => {
      order.push(1);
      counter.value++;

      const l2 = await queue.enqueue('sq-reenter-deep', async () => {
        order.push(2);
        counter.value++;

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
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const outerResult = await queue.enqueue('sq-reenter-result', async () => {
      const inner = await queue.enqueue('sq-reenter-result', async () => {
        return 42;
      });
      return inner * 2;
    });

    expect(outerResult).toBe(84);
  });

  it('reentrant enqueue does not create separate promise chain', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue();

    const order: number[] = [];

    const p1 = queue.enqueue('sq-reenter-chain', async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
    });

    const p2 = queue.enqueue('sq-reenter-chain', async () => {
      order.push(3);

      await queue.enqueue('sq-reenter-chain', async () => {
        order.push(4);
      });

      order.push(5);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('SessionQueue root resolution through the host', () => {
  it('runs a child session action on the parent workflow session', async () => {
    // `parentID` lives on the host's session record, never in a workflow
    // session file — so before the host was asked, this resolution was
    // identity and a dispatched subagent's writes never reached the parent's
    // task scope, invariants or queue.
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const asked: string[] = [];
    const chain: Record<string, string> = { 'sq-child': 'sq-mid', 'sq-mid': 'sq-root' };
    const queue = new SessionQueue(undefined, async (id) => {
      asked.push(id);
      return chain[id] ?? null;
    });

    const seen = await queue.enqueue('sq-child', async () => {
      const root = await queue.rootOf('sq-child');
      expect(root).toBe('sq-root');
      return root;
    });

    expect(seen).toBe('sq-root');
    expect(asked).toEqual(['sq-child', 'sq-mid', 'sq-root']);

    // Every node walked is memoised to the root: a second call asks nothing.
    asked.length = 0;
    await queue.enqueue('sq-child', async () => {
      const root = await queue.rootOf('sq-child');
      expect(root).toBe('sq-root');
    });
    expect(asked).toEqual([]);
  });

  it('leaves a session as its own root when the host cannot answer', async () => {
    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(undefined, async () => {
      throw new Error('host unreachable');
    });

    const seen = await queue.enqueue('sq-orphan', async () => {
      const root = await queue.rootOf('sq-orphan');
      expect(root).toBe('sq-orphan');
      return root;
    });

    expect(seen).toBe('sq-orphan');
  });
});
