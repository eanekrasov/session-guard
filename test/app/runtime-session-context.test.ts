import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeSessionContextImpl } from '../../src/app/runtime-session-context.ts';
import { SessionExecutor } from '../../src/app/session-executor.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';

describe('RuntimeSessionContext', () => {
  let storeDirectory: string;
  let store: WorkflowStore;

  beforeEach(() => {
    storeDirectory = mkdtempSync(join(tmpdir(), 'runtime-session-context-'));
    store = new WorkflowStore(storeDirectory);
  });

  afterEach(() => {
    rmSync(storeDirectory, { recursive: true, force: true });
  });

  it('loads and recognizes a governing root session', async () => {
    await store.save(createSession('root', 'base', 'session-guard', 'planning'));
    const context = new RuntimeSessionContextImpl(store, new SessionExecutor(store));

    const loaded = await context.load('root');

    expect(loaded?.sessionId).toBe('root');
    expect(await context.has('root')).toBe(true);
  });

  it('resolves child sessions to the workflow root and exposes the host parent', async () => {
    await store.save(createSession('root', 'base', 'session-guard', 'planning'));
    const parents: Record<string, string | null> = { child: 'root', root: null };
    const context = new RuntimeSessionContextImpl(
      store,
      new SessionExecutor(
        store,
        undefined,
        async (sessionID: string) => parents[sessionID] ?? null
      ),
      async (sessionID: string) => parents[sessionID] ?? null
    );

    expect(await context.rootOf('child')).toBe('root');
    expect((await context.load('child'))?.sessionId).toBe('root');
    expect(await context.parentOf('child')).toBe('root');
    expect(await context.has('child')).toBe(true);
  });

  it('treats absent ids, unknown parents, and non-workflow sessions as opt-out', async () => {
    const context = new RuntimeSessionContextImpl(
      store,
      new SessionExecutor(store, undefined, async () => null),
      async () => null
    );

    expect(await context.load(undefined)).toBeNull();
    expect(await context.has(undefined)).toBe(false);
    expect(await context.load('unknown')).toBeNull();
    expect(await context.has('unknown')).toBe(false);
    expect(await context.rootOf('host-only')).toBe('host-only');
    expect(await context.parentOf('host-only')).toBeNull();
  });

  it('falls back to the requested session when host parent lookup fails', async () => {
    const context = new RuntimeSessionContextImpl(
      store,
      new SessionExecutor(store, undefined, async () => {
        throw new Error('host unavailable');
      }),
      async () => {
        throw new Error('host unavailable');
      }
    );

    await expect(context.rootOf('child')).resolves.toBe('child');
    await expect(context.parentOf('child')).resolves.toBeNull();
  });

  it('normalizes tool names consistently', () => {
    const context = new RuntimeSessionContextImpl(store, new SessionExecutor(store));

    expect(context.normalizeTool('BASH')).toBe('bash');
    expect(context.normalizeTool('Apply_Patch')).toBe('apply_patch');
  });
});
