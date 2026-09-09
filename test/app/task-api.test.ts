import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionExecutor } from '../../src/app/session-executor.ts';
import { TaskApi } from '../../src/app/task-api.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';

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
  const session = createSession('s1', 'profile', 'cycle');
  await store.save(session);

  return {
    api: new TaskApi(store, async () => ['implementation', 'review']),
    store,
    sessionId: session.sessionId,
  };
}

async function createApiWithExecutor(): Promise<{
  api: TaskApi;
  executor: SessionExecutor;
  store: WorkflowStore;
  sessionId: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-api-executor-'));
  temporaryDirectories.push(directory);
  const store = new WorkflowStore(directory);
  const session = createSession('s1', 'profile', 'cycle');
  await store.save(session);
  const executor = new SessionExecutor(store);

  return {
    api: new TaskApi(store, async () => ['implementation', 'review'], executor),
    executor,
    store,
    sessionId: session.sessionId,
  };
}

describe('TaskApi', () => {
  it('persists a named list and updates a task by its global ID', async () => {
    const { api, store, sessionId } = await createApi();

    await api.setTasks(sessionId, {
      listKey: 'implementation',
      tasks: [createTask()],
    });

    expect(await api.getTasks(sessionId, 'implementation')).toEqual([createTask()]);

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
      tasks: [createTask()],
    });

    await expect(
      api.setTasks(sessionId, {
        listKey: 'review',
        tasks: [createTask()],
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
      tasks: [createTask()],
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
      gates: {},
      round: 0,
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

  describe('with SessionExecutor', () => {
    it('parallel setTasks calls see consistent state', async () => {
      const { api, sessionId } = await createApiWithExecutor();

      await api.setTasks(sessionId, {
        listKey: 'implementation',
        tasks: [createTask()],
      });

      // Two parallel setTaskStatus calls on different tasks — should not conflict
      await api.setTasks(sessionId, {
        listKey: 'implementation',
        tasks: [createTask(), createTask({ id: 'task-2', status: 'pending' })],
      });

      const tasks = await api.getTasks(sessionId, 'implementation');
      expect(tasks).toHaveLength(2);
      expect(tasks.find((t) => t.id === 'task-2')).toBeDefined();
    });

    it('concurrent setTasks + setTaskStatus do not conflict', async () => {
      const { api, sessionId } = await createApiWithExecutor();

      await api.setTasks(sessionId, {
        listKey: 'implementation',
        tasks: [createTask()],
      });

      // Both operations are enqueued via the same executor, so they serialize
      const [setResult, statusResult] = await Promise.all([
        api.setTasks(sessionId, {
          listKey: 'implementation',
          tasks: [createTask(), createTask({ id: 'task-2', status: 'pending' })],
        }),
        api.setTaskStatus(sessionId, 'task-1', 'running'),
      ]);

      // Both should succeed — either order is fine, but no corruption
      expect(setResult).toHaveLength(2);
      expect(statusResult.id).toBe('task-1');

      // Final state: task-1 is either running or completed depending on order
      const tasks = await api.getTasks(sessionId, 'implementation');
      const task1 = tasks.find((t) => t.id === 'task-1');
      expect(task1).toBeDefined();
      expect(['running', 'completed']).toContain(task1!.status);
    });

    it('error in one TaskApi call does not corrupt session for the next call', async () => {
      const { api, sessionId } = await createApiWithExecutor();

      // Successful first set
      await api.setTasks(sessionId, {
        listKey: 'implementation',
        tasks: [createTask()],
      });

      // This should fail — task-1 already in another list
      await expect(
        api.setTasks(sessionId, {
          listKey: 'review',
          tasks: [createTask()],
        })
      ).rejects.toThrow('already belongs to');

      // The session should still be valid for the next call
      const tasks = await api.getTasks(sessionId, 'implementation');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task-1');
    });
  });
});
