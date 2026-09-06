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
