import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WorkflowStore,
  createSession,
  WorkflowSessionConflictError,
} from '../../src/session/session-store.ts';

let storeDir: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'sm-conflict-'));
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe('WorkflowStore optimistic concurrency', () => {
  it('refuses a save built on a revision the file no longer holds', async () => {
    // `revision` was incremented on every save and compared against nothing:
    // two writers each loaded revision N, each wrote N+1, and the later one
    // erased the earlier one's work in silence.
    const store = new WorkflowStore(storeDir);
    await store.save(createSession('conflict', 'base', 'state-machine'));

    const first = await store.load('conflict');
    const second = await store.load('conflict');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    first!.title = 'written by the first writer';
    await store.save(first!);

    second!.title = 'written by the second writer';
    await expect(store.save(second!)).rejects.toBeInstanceOf(WorkflowSessionConflictError);

    const onDisk = await store.load('conflict');
    expect(onDisk?.title).toBe('written by the first writer');
  });

  it('leaves the refused session reloadable, with its revision unbumped', async () => {
    const store = new WorkflowStore(storeDir);
    await store.save(createSession('retry', 'base', 'state-machine'));

    const stale = (await store.load('retry'))!;
    const staleRevision = stale.revision;
    await store.save((await store.load('retry'))!);

    await expect(store.save(stale)).rejects.toBeInstanceOf(WorkflowSessionConflictError);
    expect(stale.revision).toBe(staleRevision);

    // Reload and the same write goes through.
    const fresh = (await store.load('retry'))!;
    fresh.title = 'after a reload';
    await store.save(fresh);
    expect((await store.load('retry'))?.title).toBe('after a reload');
  });

  it('saves the same object repeatedly without a false conflict', async () => {
    const store = new WorkflowStore(storeDir);
    const session = createSession('repeat', 'base', 'state-machine');

    await store.save(session);
    await store.save(session);
    await store.save(session);

    expect((await store.load('repeat'))?.revision).toBe(3);
  });
});

describe("the shipped profile's validation-failure edge", () => {
  it('saves the workflow-level budget it spends', async () => {
    // base.yaml's `validation → execution` edge bumps `cycles`. Saving the
    // session afterwards used to throw "Retry budget key must be a workflow
    // task id: cycles", leaving the session in validation with an empty
    // budget and no repetition that could help.
    const { bumpRetry } = await import('../../src/session/helpers.ts');
    const store = new WorkflowStore(storeDir);
    const session = createSession('cycles', 'base', 'state-machine');

    bumpRetry(session, 'cycles');
    await store.save(session);

    expect((await store.load('cycles'))?.retryBudgets['cycles']?.attempts).toBe(1);
  });
});

describe('two stores over one directory', () => {
  it('lets exactly one concurrent save win, and says so to the other', async () => {
    // The in-process lock chain serialises one WorkflowStore. It says nothing
    // about a second store, a second plugin instance or a second host: two of
    // them each read the same revision, each passed the staleness check and
    // each wrote. Both reported success and one update vanished.
    const first = new WorkflowStore(storeDir);
    const second = new WorkflowStore(storeDir);
    await first.save(createSession('race', 'base', 'state-machine'));

    const a = (await first.load('race'))!;
    const b = (await second.load('race'))!;
    a.title = 'written by the first store';
    b.title = 'written by the second store';

    const outcomes = await Promise.allSettled([first.save(a), second.save(b)]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Whichever won, the file holds that writer's work whole — not a mixture,
    // and not the loser's silent overwrite.
    const onDisk = await first.load('race');
    expect(['written by the first store', 'written by the second store']).toContain(onDisk?.title);
    expect(onDisk?.revision).toBe(2);
  });

  it('leaves no lock file behind, so the next save is not blocked', async () => {
    const { readdirSync } = await import('node:fs');
    const store = new WorkflowStore(storeDir);
    await store.save(createSession('lockless', 'base', 'state-machine'));
    const again = (await store.load('lockless'))!;
    again.title = 'second write';
    await store.save(again);

    expect(readdirSync(storeDir).filter((name) => name.endsWith('.lock'))).toEqual([]);
    expect((await store.load('lockless'))?.title).toBe('second write');
  });
});
