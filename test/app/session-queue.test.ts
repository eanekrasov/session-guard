import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { withSession } from '../../test/helpers.ts';

// ─── Helpers ──────────────────────────────────────────────────────

let storeDir: string;
let store: WorkflowStore;

beforeEach(() => {
  storeDir = '/tmp/state-machine-test-' + Math.random().toString(36).slice(2);
  store = new WorkflowStore(storeDir);
});

/** Seed a session into the store dir. */
async function seedSession(
  sessionId: string,
  profileId = 'test',
  parentId?: string
): Promise<void> {
  const session = createSession(sessionId, profileId);
  if (parentId) {
    session.testStatus['parentID'] = parentId;
  }
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
    await seedSession('sq-parent-child', 'test', 'sq-parent-root');

    const { SessionQueue } = await import('../../src/app/session-queue.ts');
    const queue = new SessionQueue(store);

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
