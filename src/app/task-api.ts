import type { MutationTask, TaskStatus, WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';

export interface SetTasksInput {
  listKey: string;
  tasks: MutationTask[];
}

export type StaticTaskListResolver = (profileId: string) => Promise<readonly string[]>;

/**
 * Durable task-list boundary. It owns task-list validation and makes each
 * successful mutation visible only after WorkflowStore persists the session.
 */
export class TaskApi {
  constructor(
    private readonly store: WorkflowStore,
    private readonly resolveStaticListKeys: StaticTaskListResolver
  ) {}

  async setTasks(sessionId: string, input: SetTasksInput): Promise<MutationTask[]> {
    const session = await this.requireSession(sessionId);
    await this.assertKnownList(session, input.listKey);
    this.assertListIsNotInUse(session, input.listKey);
    this.assertUniqueTaskIds(session, input);
    this.assertReplacementKeepsChildren(session, input);

    session.tasks[input.listKey] = input.tasks.map((task) => ({ ...task }));
    await this.store.save(session);
    return this.copyTasks(session.tasks[input.listKey]);
  }

  async getTasks(sessionId: string, listKey: string): Promise<MutationTask[]> {
    const session = await this.requireSession(sessionId);
    await this.assertKnownList(session, listKey);
    return this.copyTasks(session.tasks[listKey] ?? []);
  }

  async setTaskStatus(
    sessionId: string,
    taskId: string,
    status: TaskStatus
  ): Promise<MutationTask> {
    const session = await this.requireSession(sessionId);
    const task = Object.values(session.tasks)
      .flat()
      .find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    task.status = status;
    await this.store.save(session);
    return { ...task };
  }

  private async requireSession(sessionId: string): Promise<WorkflowSession> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Unknown workflow session: ${sessionId}`);
    }
    return session;
  }

  private async assertKnownList(session: WorkflowSession, listKey: string): Promise<void> {
    if (/^task-[0-9]+$/.test(listKey)) {
      const parentExists = Object.values(session.tasks)
        .flat()
        .some((task) => task.id === listKey);
      if (!parentExists) {
        throw new Error(`Task list ${listKey} is invalid because its parent task does not exist`);
      }
      return;
    }

    const staticListKeys = await this.resolveStaticListKeys(session.profileId);
    if (!staticListKeys.includes(listKey)) {
      throw new Error(`Unknown task list: ${listKey}`);
    }
  }

  private assertUniqueTaskIds(session: WorkflowSession, input: SetTasksInput): void {
    const incomingIds = new Set<string>();
    for (const task of input.tasks) {
      if (incomingIds.has(task.id)) {
        throw new Error(`Duplicate task ID in replacement list: ${task.id}`);
      }
      incomingIds.add(task.id);
    }

    for (const [listKey, tasks] of Object.entries(session.tasks)) {
      if (listKey === input.listKey) continue;
      for (const task of tasks) {
        if (incomingIds.has(task.id)) {
          throw new Error(`Task ${task.id} already belongs to another task list`);
        }
      }
    }
  }

  private assertListIsNotInUse(session: WorkflowSession, listKey: string): void {
    const activeRun = Object.values(session.loopRuns).find(
      (run) =>
        run.listKey === listKey && (run.status === 'running' || run.status === 'awaiting_decision')
    );
    if (!activeRun) return;

    throw new Error(
      `Cannot modify task list ${listKey} while work is in progress ` +
        `(active run ${activeRun.id}, task ${activeRun.taskId})`
    );
  }

  private assertReplacementKeepsChildren(session: WorkflowSession, input: SetTasksInput): void {
    const replacementIds = new Set(input.tasks.map((task) => task.id));
    for (const existingTask of session.tasks[input.listKey] ?? []) {
      if (!replacementIds.has(existingTask.id) && session.tasks[existingTask.id] !== undefined) {
        throw new Error(
          `Replacing ${input.listKey} would orphan child task list ${existingTask.id}`
        );
      }
    }
  }

  private copyTasks(tasks: MutationTask[]): MutationTask[] {
    return tasks.map((task) => ({ ...task }));
  }
}
