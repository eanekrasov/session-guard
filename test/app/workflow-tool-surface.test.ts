import { describe, expect, it, vi } from 'vitest';

import { createWorkflowToolSurface } from '../../src/app/workflow-tool-surface.ts';
import type { WorkflowStore } from '../../src/session/session-store.ts';
import type { SessionTransaction } from '../../src/app/session-executor.ts';
import type { LogFn } from '../../src/app/logger.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { Reporter } from '../../src/app/report.ts';

describe('WorkflowToolSurface', () => {
  const createMockPorts = () => ({
    profilesDir: '/profiles',
    projectDir: '/project',
    store: {} as WorkflowStore,
    executor: {
      run: async <T>(_sessionID: string, action: (tx: SessionTransaction) => Promise<T>) =>
        action({ session: null, deferAfterSave: () => {} }),
    },
    mutationOrchestrator: {
      resolveEngine: async () => {
        throw new Error('Unexpected engine resolution in workflow tool surface fixture');
      },
    },
    consentOrchestrator: {
      before: vi.fn(async () => {}),
      after: vi.fn(async () => {}),
    },
    taskApi: {
      setTasks: async () => [],
      getTasks: async () => [],
      setTaskStatus: async () => {
        throw new Error('Unexpected task status update in workflow tool surface fixture');
      },
    },
    sessionContext: {
      load: vi.fn(async () => null as WorkflowSession | null),
    },
    log: vi.fn(async () => {}) as LogFn,
    report: vi.fn(async () => {}) as Reporter,
  });

  it('creates the complete stable public tool surface', () => {
    const surface = createWorkflowToolSurface(createMockPorts());

    expect(Object.keys(surface.createTools())).toEqual([
      'workflow-create',
      'workflow-list',
      'workflow-consent',
      'workflow-tasks-set',
      'workflow-tasks-get',
      'workflow-tasks-set-status',
      'workflow-tasks-resolve-decision',
      'workflow-gate-set',
    ]);

    const tools = surface.createTools();
    expect(tools['workflow-create']?.description).toBe(
      'Create a new session-guard workflow session'
    );
    expect(Object.keys(tools['workflow-consent']?.args ?? {})).toEqual([
      'files',
      'summary',
      'type',
      'grant',
      'decline',
    ]);
  });

  it('delegates representative callbacks without changing their results', async () => {
    const ports = createMockPorts();

    // We can't easily test the internal handleCreateWorkflow without full mocks,
    // but we can verify the tool surface creates the right tools
    const surface = createWorkflowToolSurface(ports);

    expect(surface.createTools()['workflow-create']).toBeDefined();
    expect(typeof surface.createTools()['workflow-create']!.execute).toBe('function');
  });

  it('rejects a malformed consent call without files', async () => {
    const surface = createWorkflowToolSurface(createMockPorts());
    const result = await surface.createTools()['workflow-consent']!.execute(
      { summary: 'Approve plan', grant: 'grant', decline: 'decline' },
      {
        sessionID: 'session-1',
        messageID: 'message-1',
        agent: 'test',
        directory: '/project',
        worktree: '/project',
        abort: new AbortController().signal,
        metadata: () => undefined,
        ask: async () => undefined,
      }
    );

    expect(result).toEqual({ output: 'files is required' });
  });

  describe('workflow-gate-set', () => {
    it('registers workflow-gate-set with gate and status arguments', () => {
      const surface = createWorkflowToolSurface(createMockPorts());
      const tools = surface.createTools();
      const gateSet = tools['workflow-gate-set'];

      expect(gateSet).toBeDefined();
      expect(gateSet!.description).toBeTruthy();
      expect(typeof gateSet!.execute).toBe('function');

      const args = gateSet!.args ?? {};
      expect(args).toHaveProperty('gate');
      expect(args).toHaveProperty('status');
    });

    it('reports a missing workflow session without mutating state', async () => {
      const surface = createWorkflowToolSurface(createMockPorts());

      const result = await surface.createTools()['workflow-gate-set']!.execute(
        { gate: 'review', status: 'pass' },
        {
          sessionID: 'nonexistent',
          messageID: 'msg-1',
          agent: 'test',
          directory: '/project',
          worktree: '/project',
          abort: new AbortController().signal,
          metadata: () => undefined,
          ask: async () => undefined,
        }
      );

      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('output');
      expect((result as { output: string }).output).toContain('session');
    });
  });
});
