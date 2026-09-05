import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WorkflowSessionSchema } from '../../src/session/session-schema.ts';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createStore(): Promise<{ directory: string; store: WorkflowStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-cycle-session-'));
  temporaryDirectories.push(directory);
  return { directory, store: new WorkflowStore(directory) };
}

describe('task-cycle session persistence', () => {
  it('preserves multiple simultaneous operations through save and load', async () => {
    const { directory, store } = await createStore();
    const session = createSession('multiple-operations', 'android');
    session.tasks = {
      implementation: [
        { id: 'task-1', path: 'src/a.ts', status: 'running' },
        { id: 'task-2', path: 'src/b.ts', status: 'pending' },
      ],
    };
    session.loopRuns = {
      'run-1': {
        id: 'run-1',
        taskId: 'task-1',
        listKey: 'implementation',
        ancestry: [],
        stage: 'implementation',
        status: 'running',
      },
      'run-2': {
        id: 'run-2',
        taskId: 'task-2',
        listKey: 'implementation',
        ancestry: [],
        stage: 'implementation',
        status: 'pending',
      },
    };
    session.activeOperations = {
      'call-1': {
        callId: 'call-1',
        runId: 'run-1',
        taskId: 'task-1',
        agent: 'implementer',
        status: 'running',
        startedAt: '2026-09-01T00:00:00.000Z',
      },
      'call-2': {
        callId: 'call-2',
        runId: 'run-2',
        taskId: 'task-2',
        agent: 'reviewer',
        status: 'interrupted',
        startedAt: '2026-09-01T00:01:00.000Z',
        interruptedAt: '2026-09-01T00:02:00.000Z',
      },
    };
    session.retryBudgets = {
      'task-1': { attempts: 0, maximum: 3 },
      'task-2': { attempts: 1, maximum: 3 },
    };

    await store.save(session);

    const loaded = await store.load(session.sessionId);
    const persisted = JSON.parse(
      await readFile(path.join(directory, `${encodeURIComponent(session.sessionId)}.json`), 'utf-8')
    ) as Record<string, unknown>;
    expect(loaded?.activeOperations).toEqual(session.activeOperations);
    expect(loaded?.loopRuns).toEqual(session.loopRuns);
    expect(persisted).not.toHaveProperty('currentTaskIndex');
    expect(persisted).not.toHaveProperty('activeOperation');
  });

  it('initializes collection fields for created and newly persisted sessions', async () => {
    const { directory, store } = await createStore();
    const created = createSession('created', 'android');
    expect(created.tasks).toEqual({});
    expect(created.activeOperations).toEqual({});
    expect(created.loopRuns).toEqual({});
    expect(created.retryBudgets).toEqual({});

    const filePath = path.join(directory, 'new-form.json');
    await writeFile(
      filePath,
      JSON.stringify({
        sessionId: 'new-form',
        profileId: 'android',
      }),
      'utf-8'
    );

    const loaded = await store.load('new-form');
    expect(loaded?.tasks).toEqual({});
    expect(loaded?.activeOperations).toEqual({});
    expect(loaded?.loopRuns).toEqual({});
    expect(loaded?.retryBudgets).toEqual({});
  });

  it('rejects malformed and duplicate workflow task IDs', () => {
    expect(() =>
      WorkflowSessionSchema.parse({
        sessionId: 'invalid-id',
        profileId: 'android',
        tasks: {
          implementation: [{ id: 'invalid', path: 'src/a.ts', status: 'pending' }],
        },
      })
    ).toThrow();

    expect(() =>
      WorkflowSessionSchema.parse({
        sessionId: 'duplicate-id',
        profileId: 'android',
        tasks: {
          implementation: [{ id: 'task-1', path: 'src/a.ts', status: 'pending' }],
          review: [{ id: 'task-1', path: 'src/b.ts', status: 'pending' }],
        },
      })
    ).toThrow();
  });

  it('rejects loop runs whose record key differs from the generated run ID', () => {
    expect(() =>
      WorkflowSessionSchema.parse({
        sessionId: 'mismatched-run-key',
        profileId: 'android',
        loopRuns: {
          'other-key': {
            id: 'run-1',
            taskId: 'task-1',
            listKey: 'implementation',
            ancestry: [],
            stage: 'implementation',
            status: 'running',
          },
        },
      })
    ).toThrow();
  });
});
