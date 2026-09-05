/**
 * Provider — абстракция над внешним issue/task трекером.
 *
 * Плагин не должен зависеть от конкретного CLI (bd, gh, jira).
 * Provider определяет интерфейс TaskProvider, который плагин получает
 * через DI при создании runtime.
 */

// ─── Provider interface ───────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  state: string;
  priority: string;
  description?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  assignee?: string;
  labels?: string[];
}

export interface TaskProvider {
  /** Получить задачу по ID */
  getTask(id: string): Promise<Task>;
  /** Список задач, готовых к работе */
  getReadyTasks(): Promise<Task[]>;
  /** Оставить комментарий в задаче */
  postComment(taskId: string, text: string, author: string): Promise<void>;
}

// ─── InMemoryProvider (для тестов и отладки) ──────────────────────────────────

export class InMemoryProvider implements TaskProvider {
  private tasks = new Map<string, Task>();

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  async getTask(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    return task;
  }

  async getReadyTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.state === 'ready');
  }

  async postComment(_taskId: string, _text: string, _author: string): Promise<void> {
    // InMemory — no-op
  }
}

// ─── Shell executor abstraction ──────────────────────────────────────────────

/**
 * Injectable shell abstraction so tests can mock process execution
 * without depending on Bun.spawn.
 */
export interface ShellExecutor {
  run(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
  runRaw(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Production executor backed by Bun.spawn.
 */
export function createBunExecutor(command: string): ShellExecutor {
  return {
    async run(
      args: string[]
    ): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
      try {
        const proc = Bun.spawn({
          cmd: [command, ...args],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        if (code !== 0) return { ok: false, error: stderr.trim() };
        return { ok: true, stdout: stdout.trim() };
      } catch {
        return { ok: false, error: `${command} CLI not available` };
      }
    },

    async runRaw(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const proc = Bun.spawn({
        cmd: [command, ...args],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
    },
  };
}

// ─── Options for CLI adapter ──────────────────────────────────────────────────

export interface CliProviderOptions {
  command?: string; // по умолчанию "bd"
  ttlMs?: number; // кеш в мс (0 = без кеша)
  /** Injectable executor — defaults to Bun.spawn when omitted */
  executor?: ShellExecutor;
}

/**
 * Создаёт TaskProvider через внешний CLI.
 *
 * Ожидает команду с флагами:
 *   <cmd> show <id> --json   → JSON объекта
 *   <cmd> ready --json        → JSON массива
 *   <cmd> comment <id> <text> --actor <author>
 */
export function createCliProvider(opts?: CliProviderOptions): TaskProvider {
  const cmd = opts?.command ?? 'bd';
  const ttl = opts?.ttlMs ?? 30_000;
  const exec = opts?.executor ?? createBunExecutor(cmd);

  const cache = ttl > 0 ? new Map<string, { value: unknown; expiresAt: number }>() : null;

  function getCached<T>(key: string): T | null {
    if (!cache) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  function setCache(key: string, value: unknown): void {
    if (!cache) return;
    cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  function cacheKey(...parts: string[]): string {
    return parts.join(':');
  }

  function escapeArg(value: string): string {
    return value.replace(/["$\\`]/g, (c) => `\\${c}`);
  }

  function parseTask(raw: Record<string, unknown>): Task {
    return {
      id: String(raw.id ?? ''),
      title: String(raw.title ?? ''),
      state: String(raw.state ?? ''),
      priority: String(raw.priority ?? ''),
      description: raw.description ? String(raw.description) : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
      createdAt: raw.createdAt ? String(raw.createdAt) : undefined,
      updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
      assignee: raw.assignee ? String(raw.assignee) : undefined,
      labels: Array.isArray(raw.labels) ? raw.labels.map(String) : undefined,
    };
  }

  const provider: TaskProvider = {
    async getTask(id: string): Promise<Task> {
      const ck = cacheKey('show', id);
      const cached = getCached<Task>(ck);
      if (cached) return cached;

      const result = await exec.run(['show', id, '--json']);
      if (result.ok === false) throw new Error(result.error);

      const parsed = JSON.parse(result.stdout);
      const task = parseTask(parsed as Record<string, unknown>);
      setCache(ck, task);
      return task;
    },

    async getReadyTasks(): Promise<Task[]> {
      const ck = cacheKey('ready');
      const cached = getCached<Task[]>(ck);
      if (cached) return cached;

      const result = await exec.run(['ready', '--json']);
      if (result.ok === false) throw new Error(result.error);

      const raw = JSON.parse(result.stdout);
      const tasks: Task[] = (Array.isArray(raw) ? raw : []).map((item: unknown) =>
        parseTask(item as Record<string, unknown>)
      );
      setCache(ck, tasks);
      return tasks;
    },

    async postComment(taskId: string, text: string, author: string): Promise<void> {
      const safeText = escapeArg(text);
      const safeAuthor = escapeArg(author);

      const { exitCode, stderr } = await exec.runRaw([
        'comment',
        taskId,
        safeText,
        '--actor',
        safeAuthor,
      ]);

      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `${cmd} comment failed with code ${exitCode}`);
      }
    },
  };

  return provider;
}
