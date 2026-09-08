import type { MutationTask, TaskStatus, WorkflowSession } from '../session/session-schema.ts';
import { WorkflowStore } from '../session/session-store.ts';
import type { SessionExecutor } from './session-executor.ts';
import { isOpenLoopRun, removeActiveTaskContext } from '../session/helpers.ts';

export interface SetTasksInput {
  listKey: string;
  tasks: MutationTask[];
}

/**
 * The task lists the workflow a session runs declares, by its `loop:` sources.
 *
 * Takes the schema as well as the profile: a profile may hold several
 * independent schemas, and only the one the session runs says which lists
 * exist. Resolving over all of them accepts a list key belonging to a workflow
 * nobody is running.
 */
export type StaticTaskListResolver = (
  _profileId: string,
  _schemaId?: string
) => Promise<readonly string[]>;

/**
 * Durable task-list boundary. It owns task-list validation and makes each
 * successful mutation visible only after WorkflowStore persists the session.
 *
 * When a `SessionExecutor` is provided, all public write methods are wrapped
 * in the executor to serialise operations per root session with full lifecycle.
 */
export class TaskApi {
  constructor(
    private readonly store: WorkflowStore,
    private readonly resolveStaticListKeys: StaticTaskListResolver,
    private readonly executor?: SessionExecutor
  ) {}

  async setTasks(sessionId: string, input: SetTasksInput): Promise<MutationTask[]> {
    return this.runInExecutor(sessionId, async (session) => {
      if (!session) throw new Error(`Unknown workflow session: ${sessionId}`);
      await this.assertKnownList(session, input.listKey);
      this.assertListIsNotInUse(session, input.listKey);
      this.assertUniqueTaskIds(session, input);
      this.assertReplacementKeepsChildren(session, input);

      session.tasks[input.listKey] = input.tasks.map((task) => ({ ...task }));
      return this.copyTasks(session.tasks[input.listKey]);
    });
  }

  /**
   * Read one list. Reading changes nothing, so nothing is written.
   *
   * This used to go through `runInQueue`, and both of that helper's paths save
   * the session unconditionally — so a single `workflow-tasks-get` bumped the
   * revision from 5 to 6 without a task having moved. Every read wrote a
   * version nobody asked for, and with optimistic concurrency in place those
   * are conflicts waiting for a second writer.
   */
  async getTasks(sessionId: string, listKey: string): Promise<MutationTask[]> {
    const rootId = this.executor ? await this.executor.rootOf(sessionId) : sessionId;
    const session = await this.requireSession(rootId);
    await this.assertKnownList(session, listKey);
    return this.copyTasks(session.tasks[listKey] ?? []);
  }

  async setTaskStatus(
    sessionId: string,
    taskId: string,
    status: TaskStatus
  ): Promise<MutationTask> {
    return this.runInExecutor(sessionId, async (session) => {
      if (!session) throw new Error(`Unknown workflow session: ${sessionId}`);
      const task = Object.values(session.tasks)
        .flat()
        .find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new Error(`Unknown task: ${taskId}`);
      }

      task.status = status;
      if (status === 'cancelled' || status === 'failed') this.closeExecution(session, task.id);
      return { ...task };
    });
  }

  /**
   * End whatever is still running for a task the controller has just stopped.
   *
   * Cancelling only ever wrote the task's own status, so the run stayed open
   * and the call stayed active: a late result from the worker found them,
   * moved the task back to `running` and carried it on to `verify`. A task
   * that was cancelled is not a task that is still being worked on.
   *
   * `completed` is deliberately not here — the task's own movement sets it,
   * and closing the run from the side would race with that.
   */
  private closeExecution(session: WorkflowSession, taskId: string): void {
    for (const run of Object.values(session.loopRuns)) {
      if (run.taskId !== taskId || !isOpenLoopRun(run)) continue;
      run.status = 'cancelled';
      removeActiveTaskContext(session, run.id);
      for (const operation of Object.values(session.activeOperations)) {
        if (operation.runId === run.id) delete session.activeOperations[operation.callId];
      }
    }
  }

  /**
   * Wrap a function in the executor if one is configured, or run directly.
   * When using the executor, the session is loaded by the executor and passed to
   * the callback — operations use this reference directly so saves are
   * consistently handled by the executor.
   */
  private async runInExecutor<T>(
    sessionId: string,
    fn: (session: WorkflowSession | null) => Promise<T>
  ): Promise<T> {
    if (this.executor) {
      return this.executor.run(sessionId, async (tx) => fn(tx.session));
    }
    // No executor: load session directly and save after the operation
    const session = await this.requireSession(sessionId);
    const result = await fn(session);
    await this.store.save(session);
    return result;
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

    const staticListKeys = await this.resolveStaticListKeys(session.profileId, session.schemaId);
    if (!staticListKeys.includes(listKey)) {
      throw new Error(
        `Unknown task list: ${listKey}. ` +
          `${session.profileId}/${session.schemaId} declares ` +
          `${staticListKeys.length > 0 ? `[${staticListKeys.join(', ')}]` : 'no task list'}`
      );
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
