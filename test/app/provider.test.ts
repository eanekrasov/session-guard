import { describe, it, expect } from 'vitest';
import {
  InMemoryProvider,
  createCliProvider,
  createBunExecutor,
  type ShellExecutor,
} from '../../src/app/provider.ts';

describe('InMemoryProvider', () => {
  it('getTask returns task by id', async () => {
    const provider = new InMemoryProvider();
    provider.addTask({
      id: 'TASK-1',
      title: 'Fix login bug',
      state: 'ready',
      priority: 'high',
    });

    const task = await provider.getTask('TASK-1');

    expect(task.id).toBe('TASK-1');
    expect(task.title).toBe('Fix login bug');
    expect(task.state).toBe('ready');
  });

  it('getTask throws when task not found', async () => {
    const provider = new InMemoryProvider();

    await expect(provider.getTask('NONEXISTENT')).rejects.toThrow('Task "NONEXISTENT" not found');
  });

  it('getReadyTasks returns only ready tasks', async () => {
    const provider = new InMemoryProvider();
    provider.addTask({ id: 'T1', title: 'Ready task', state: 'ready', priority: 'medium' });
    provider.addTask({ id: 'T2', title: 'In progress', state: 'active', priority: 'high' });
    provider.addTask({ id: 'T3', title: 'Done', state: 'completed', priority: 'low' });

    const ready = await provider.getReadyTasks();

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('T1');
  });

  it('getReadyTasks returns empty array when no ready tasks', async () => {
    const provider = new InMemoryProvider();
    provider.addTask({ id: 'T1', title: 'Active', state: 'active', priority: 'high' });

    const ready = await provider.getReadyTasks();

    expect(ready).toEqual([]);
  });

  it('postComment does not throw', async () => {
    const provider = new InMemoryProvider();

    await expect(
      provider.postComment('TASK-1', 'Looking into this', 'test-user')
    ).resolves.toBeUndefined();
  });

  it('parses optional fields correctly', async () => {
    const provider = new InMemoryProvider();
    const now = new Date().toISOString();
    provider.addTask({
      id: 'T-42',
      title: 'Full task',
      state: 'ready',
      priority: 'critical',
      description: 'Detailed description',
      tags: ['bug', 'auth'],
      createdAt: now,
      updatedAt: now,
      assignee: 'alice',
      labels: ['security'],
    });

    const task = await provider.getTask('T-42');

    expect(task.description).toBe('Detailed description');
    expect(task.tags).toEqual(['bug', 'auth']);
    expect(task.assignee).toBe('alice');
  });
});

// ─── Mock executor for CLI provider tests ──────────────────────────────────

function mockExecutor(
  responses: Record<string, { ok: true; stdout: string } | { ok: false; error: string }>
): ShellExecutor {
  const rawResponses: Record<string, { exitCode: number; stdout: string; stderr: string }> = {};
  for (const [key, val] of Object.entries(responses)) {
    if (val.ok) {
      rawResponses[key] = {
        exitCode: 0,
        stdout: (val as { stdout?: string }).stdout ?? '',
        stderr: '',
      };
    } else {
      rawResponses[key] = {
        exitCode: 1,
        stdout: '',
        stderr: (val as { error?: string }).error ?? '',
      };
    }
  }

  return {
    run: async (args) => {
      const key = args.join(' ');
      const resp = responses[key];
      if (!resp) return { ok: false, error: `unexpected call: ${key}` };
      return resp;
    },
    runRaw: async (args) => {
      const key = args.join(' ');
      const resp = rawResponses[key];
      if (!resp) return { exitCode: 1, stdout: '', stderr: `unexpected call: ${key}` };
      return resp;
    },
  };
}

describe('createCliProvider', () => {
  describe('getTask', () => {
    it('returns parsed task from CLI stdout', async () => {
      const executor = mockExecutor({
        'show TASK-1 --json': {
          ok: true,
          stdout: JSON.stringify({
            id: 'TASK-1',
            title: 'My Task',
            state: 'active',
            priority: 'high',
          }),
        },
      });

      const provider = createCliProvider({ executor, ttlMs: 0 });
      const task = await provider.getTask('TASK-1');

      expect(task.id).toBe('TASK-1');
      expect(task.title).toBe('My Task');
      expect(task.state).toBe('active');
      expect(task.priority).toBe('high');
    });

    it('throws on CLI error', async () => {
      const executor = mockExecutor({
        'show BAD --json': { ok: false, error: 'Task not found' },
      });

      const provider = createCliProvider({ executor, ttlMs: 0 });
      await expect(provider.getTask('BAD')).rejects.toThrow('Task not found');
    });

    it('caches task by id (within TTL)', async () => {
      let callCount = 0;
      const executor: ShellExecutor = {
        run: async (args) => {
          callCount++;
          return {
            ok: true,
            stdout: JSON.stringify({ id: args[1], title: 'T', state: 's', priority: 'p' }),
          };
        },
        runRaw: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      };

      const provider = createCliProvider({ executor, ttlMs: 30_000 });
      await provider.getTask('T-1');
      await provider.getTask('T-1');

      // Second call should hit cache
      expect(callCount).toBe(1);
    });

    it('bypasses cache when ttlMs=0', async () => {
      let callCount = 0;
      const executor: ShellExecutor = {
        run: async (args) => {
          callCount++;
          return {
            ok: true,
            stdout: JSON.stringify({ id: args[1], title: 'T', state: 's', priority: 'p' }),
          };
        },
        runRaw: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      };

      const provider = createCliProvider({ executor, ttlMs: 0 });
      await provider.getTask('T-1');
      await provider.getTask('T-1');

      // No cache → two calls
      expect(callCount).toBe(2);
    });
  });

  describe('getReadyTasks', () => {
    it('returns parsed task list', async () => {
      const executor = mockExecutor({
        'ready --json': {
          ok: true,
          stdout: JSON.stringify([
            { id: 'T1', title: 'Ready1', state: 'ready', priority: 'high' },
            { id: 'T2', title: 'Ready2', state: 'ready', priority: 'medium' },
          ]),
        },
      });

      const provider = createCliProvider({ executor, ttlMs: 0 });
      const tasks = await provider.getReadyTasks();

      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe('T1');
      expect(tasks[1].id).toBe('T2');
    });

    it('returns empty array on non-array stdout', async () => {
      const executor = mockExecutor({
        'ready --json': { ok: true, stdout: '{}' },
      });

      const provider = createCliProvider({ executor, ttlMs: 0 });
      const tasks = await provider.getReadyTasks();

      expect(tasks).toEqual([]);
    });

    it('throws on CLI error', async () => {
      const executor = mockExecutor({
        'ready --json': { ok: false, error: 'Auth failed' },
      });

      const provider = createCliProvider({ executor, ttlMs: 0 });
      await expect(provider.getReadyTasks()).rejects.toThrow('Auth failed');
    });
  });

  describe('postComment', () => {
    it('succeeds on zero exit code', async () => {
      const calls: string[] = [];
      const executor: ShellExecutor = {
        run: async () => ({ ok: true, stdout: '' }),
        runRaw: async (args) => {
          calls.push(args.join(' '));
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };

      const provider = createCliProvider({ executor, ttlMs: 0, command: 'gh' });
      await provider.postComment('T-1', 'looks good', 'alice');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('comment T-1');
      expect(calls[0]).toContain('--actor alice');
    });

    it('throws on non-zero exit code', async () => {
      const executor: ShellExecutor = {
        run: async () => ({ ok: true, stdout: '' }),
        runRaw: async () => ({ exitCode: 1, stdout: '', stderr: 'Permission denied' }),
      };

      const provider = createCliProvider({ executor, ttlMs: 0 });
      await expect(provider.postComment('T-1', 'text', 'me')).rejects.toThrow('Permission denied');
    });

    it('escapes special characters in text', async () => {
      const calls: string[] = [];
      const executor: ShellExecutor = {
        run: async () => ({ ok: true, stdout: '' }),
        runRaw: async (args) => {
          calls.push(args.join(' '));
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };

      const provider = createCliProvider({ executor, ttlMs: 0, command: 'gh' });
      await provider.postComment('T-1', 'price is $100 "done"', 'bob');

      const call = calls[0];
      expect(call).toContain('\\$100');
      expect(call).toContain('\\"done\\"');
    });
  });

  describe('parseTask', () => {
    it('handles missing optional fields', async () => {
      const executor = mockExecutor({
        'show MINIMAL --json': {
          ok: true,
          stdout: JSON.stringify({ id: 'MINIMAL', title: 'Min', state: 'x', priority: 'p' }),
        },
      });

      const provider = createCliProvider({ executor, ttlMs: 0 });
      const task = await provider.getTask('MINIMAL');

      expect(task.description).toBeUndefined();
      expect(task.tags).toBeUndefined();
      expect(task.assignee).toBeUndefined();
    });
  });
});

describe('createBunExecutor', () => {
  it('returns run and runRaw methods', () => {
    const exec = createBunExecutor('echo');
    expect(exec.run).toBeDefined();
    expect(exec.runRaw).toBeDefined();
  });

  it('runRaw returns exitCode, stdout, stderr', async () => {
    const exec = createBunExecutor('echo');
    const result = await exec.runRaw(['hello', 'world']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
  });

  it('run returns ok for successful command', async () => {
    const exec = createBunExecutor('echo');
    const result = await exec.run(['test output']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.trim()).toBe('test output');
    }
  });

  it('run returns error for failing command', async () => {
    const exec = createBunExecutor('sh');
    const result = await exec.run(['-c', 'exit 1']);
    expect(result.ok).toBe(false);
    // `strictNullChecks: false` не сужает размеченное объединение по `ok`.
    expect((result as { error?: string }).error).toBeDefined();
  });
});
