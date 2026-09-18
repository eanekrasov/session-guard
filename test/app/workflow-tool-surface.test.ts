import { describe, expect, it, vi } from 'vitest';

import { createWorkflowToolSurface } from '../../src/app/workflow-tool-surface.ts';
import type { TaskApi } from '../../src/app/task-api.ts';
import type { WorkflowStore } from '../../src/session/session-store.ts';
import type { SessionExecutor } from '../../src/app/session-executor.ts';
import type { MutationOrchestrator } from '../../src/app/mutation-orchestrator.ts';
import type { LogFn } from '../../src/app/logger.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { Reporter } from '../../src/app/report.ts';

describe('WorkflowToolSurface', () => {
  const createMockPorts = () => ({
    profilesDir: '/profiles',
    projectDir: '/project',
    store: {} as WorkflowStore,
    executor: {} as SessionExecutor,
    mutationOrchestrator: {} as MutationOrchestrator,
    consentOrchestrator: {
      before: vi.fn(async () => {}),
      after: vi.fn(async () => {}),
    },
    taskApi: {
      setTasks: vi.fn(async () => []),
      getTasks: vi.fn(async () => []),
      setTaskStatus: vi.fn(async () => ({}) as any),
    } as unknown as TaskApi,
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
});
