import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TaskApi } from '../../src/app/task-api.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createApi(): Promise<{ api: TaskApi; store: WorkflowStore; sessionId: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-api-'));
  temporaryDirectories.push(directory);
  const store = new WorkflowStore(directory);
  const session = createSession('s1', 'profile');
  await store.save(session);

  return {
    api: new TaskApi(store, async () => ['implementation', 'review']),
    store,
    sessionId: session.sessionId,
  };
}

describe('TaskApi', () => {
  it('persists a named list and updates a task by its global ID', async () => {
    const { api, store, sessionId } = await createApi();

    await api.setTasks(sessionId, {
      listKey: 'implementation',
      tasks: [{ id: 'task-1', path: 'src/a.ts', status: 'pending' }],
    });

    expect(await api.getTasks(sessionId, 'implementation')).toEqual([
      { id: 'task-1', path: 'src/a.ts', status: 'pending' },
    ]);

    await api.setTaskStatus(sessionId, 'task-1', 'completed');

    const persisted = await store.load(sessionId);
    expect(persisted?.tasks.implementation[0].status).toBe('completed');
    expect(persisted?.retryBudgets).toEqual({});
  });

  it('rejects a list that the selected profile does not declare', async () => {
    const { api, sessionId } = await createApi();

    await expect(api.setTasks(sessionId, { listKey: 'unknown', tasks: [] })).rejects.toThrow(
      'Unknown task list'
    );
  });

  it('rejects task IDs that occur in another list', async () => {
    const { api, sessionId } = await createApi();
    await api.setTasks(sessionId, {
      listKey: 'implementation',
      tasks: [{ id: 'task-1', path: 'src/a.ts', status: 'pending' }],
    });

    await expect(
      api.setTasks(sessionId, {
        listKey: 'review',
        tasks: [{ id: 'task-1', path: 'src/b.ts', status: 'pending' }],
      })
    ).rejects.toThrow('already belongs to another task list');
  });

  it('rejects a task-shaped list key without its parent task', async () => {
    const { api, sessionId } = await createApi();

    await expect(api.setTasks(sessionId, { listKey: 'task-17', tasks: [] })).rejects.toThrow(
      'parent task does not exist'
    );
  });

  it('does not orphan a child list when replacing its parent list', async () => {
    const { api, sessionId } = await createApi();
    await api.setTasks(sessionId, {
      listKey: 'implementation',
      tasks: [{ id: 'task-1', path: 'src/a.ts', status: 'pending' }],
    });
    await api.setTasks(sessionId, { listKey: 'task-1', tasks: [] });

    await expect(api.setTasks(sessionId, { listKey: 'implementation', tasks: [] })).rejects.toThrow(
      'would orphan child task list task-1'
    );
  });

  it('rejects replacing a task list with an active loop run', async () => {
    const { api, store, sessionId } = await createApi();
    const session = await store.load(sessionId);
    session!.loopRuns['run-1'] = {
      id: 'run-1',
      taskId: 'task-1',
      listKey: 'implementation',
      ancestry: [],
      stage: 'code',
      status: 'running',
    };
    await store.save(session!);

    await expect(api.setTasks(sessionId, { listKey: 'implementation', tasks: [] })).rejects.toThrow(
      'Cannot modify task list implementation while work is in progress'
    );
  });

  it('rejects a status change for an unknown global task ID', async () => {
    const { api, sessionId } = await createApi();

    await expect(api.setTaskStatus(sessionId, 'task-404', 'completed')).rejects.toThrow(
      'Unknown task: task-404'
    );
  });
});
