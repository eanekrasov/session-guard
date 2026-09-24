import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { registerWorkflowTools } from '../../src/app/v2-tool-surface-adapter.ts';
import type { WorkflowToolSurfacePorts } from '../../src/app/workflow-tool-surface.ts';
import type { WorkflowStore } from '../../src/session/session-store.ts';
import type { TaskApi } from '../../src/app/task-api.ts';
import type { SessionExecutor } from '../../src/app/session-executor.ts';
import type { MutationOrchestrator } from '../../src/app/mutation-orchestrator.ts';
import type { LogFn } from '../../src/app/logger.ts';
import type { Reporter } from '../../src/app/report.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createSession } from '../../src/session/session-store.ts';

// ── Test helpers ──────────────────────────────────────────────────────────

/** Tool shape captured by the fake editor */
interface CapturedTool {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly execute: (
    input: unknown,
    context: { sessionID: string; agent: string }
  ) => Effect.Effect<{ output?: string; metadata?: unknown }, { message: string }>;
}

function createMockPorts(): WorkflowToolSurfacePorts {
  return {
    profilesDir: '/profiles',
    projectDir: '/project',
    store: {} as WorkflowStore,
    executor: {} as SessionExecutor,
    mutationOrchestrator: {
      resolveEngine: vi.fn(async () => ({
        getInitialStage: () => 'CREATE',
        getTaskControlAgents: () => ['task-controller'],
        getLoopStage: vi.fn(),
      })),
    } as unknown as MutationOrchestrator,
    consentOrchestrator: {
      before: vi.fn(async () => {}),
      after: vi.fn(async () => {}),
    },
    taskApi: {
      setTasks: vi.fn(async () => []),
      getTasks: vi.fn(async () => []),
      setTaskStatus: vi.fn(async () => ({
        id: 'task-1',
        status: 'pending' as const,
      })),
    } as unknown as TaskApi,
    sessionContext: {
      load: vi.fn(async () => null as WorkflowSession | null),
    },
    log: vi.fn(async () => {}) as LogFn,
    report: vi.fn(async () => {}) as Reporter,
  };
}

function fakeEditor(): {
  editor: { add: (tool: unknown) => void };
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
  return {
    editor: {
      add: (tool) => tools.push(tool as CapturedTool),
    },
    tools,
  };
}

/** Run a V2 Effect tool.execute and return its resolved output */
async function runTool(
  tool: CapturedTool,
  input: Record<string, unknown> = {},
  context: { sessionID: string; agent: string } = { sessionID: 'ses-test', agent: '' }
): Promise<{ output?: string; metadata?: unknown }> {
  return Effect.runPromise(tool.execute(input, context));
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('V2ToolSurfaceAdapter', () => {
  describe('public surface', () => {
    it('registers the complete stable public tool surface (7 tools)', () => {
      const ports = createMockPorts();
      const { editor, tools } = fakeEditor();

      registerWorkflowTools(editor as any, ports);

      expect(tools.map((t) => t.name)).toEqual([
        'workflow-list',
        'workflow-create',
        'workflow-consent',
        'workflow-tasks-set',
        'workflow-tasks-get',
        'workflow-tasks-set-status',
        'workflow-tasks-resolve-decision',
      ]);
    });
  });

  describe('workflow-list', () => {
    it('returns an empty profile listing when no profiles exist', async () => {
      const { editor, tools } = fakeEditor();
      const ports = createMockPorts();

      registerWorkflowTools(editor as any, ports);

      const wl = tools.find((t) => t.name === 'workflow-list')!;
      expect(wl.description).toContain('List all available workflow profiles');
      expect(wl.input).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      });

      const result = await runTool(wl);
      expect(result.output).toContain('profilesDir: /profiles');
      expect(result.output).toContain('(no profiles found)');
    });
  });

  describe('tool metadata', () => {
    it('assigns V2-compatible JSON Schema input to every tool', () => {
      const { editor, tools } = fakeEditor();
      registerWorkflowTools(editor as any, createMockPorts());

      for (const tool of tools) {
        expect(tool.input).toMatchObject({
          type: 'object',
          properties: expect.any(Object),
        });
      }
    });

    it('assigns a non-empty description to every tool', () => {
      const { editor, tools } = fakeEditor();
      registerWorkflowTools(editor as any, createMockPorts());

      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(5);
      }
    });
  });

  describe('workflow-create', () => {
    it('returns profile-not-found when no profiles exist', async () => {
      const { editor, tools } = fakeEditor();
      const ports = createMockPorts();

      registerWorkflowTools(editor as any, ports);

      const wc = tools.find((t) => t.name === 'workflow-create')!;
      const input = wc.input as { properties: Record<string, unknown> };
      expect(input.properties.schemaId).toBeDefined();

      const result = await runTool(wc, { schemaId: 'nonexistent' });
      expect(result.output).toContain('No workflow profiles found');
    });
  });

  describe('execution error handling', () => {
    it('recovers gracefully when the profiles directory does not exist', async () => {
      const { editor, tools } = fakeEditor();
      const ports = createMockPorts();
      ports.profilesDir = '/nonexistent-path-12345';

      registerWorkflowTools(editor as any, ports);

      const wl = tools.find((t) => t.name === 'workflow-list')!;
      const result = await runTool(wl);
      // listProfiles handles missing directories and returns empty — the
      // tool should produce a normal output, not throw.
      expect(result.output).toContain('profilesDir: /nonexistent-path-12345');
      expect(result.output).toContain('(no profiles found)');
    });
  });
});
