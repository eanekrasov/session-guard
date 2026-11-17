import { describe, expect, it, vi } from 'bun:test';
import type { ToolEditor } from '@opencode/plugin/promise/tool';
import { CallID } from '@opencode/plugin/promise/tool';
import { Agent, Session, SessionMessage } from '@opencode/schema';

import { registerWorkflowTools } from '../../src/app/v2-tool-surface-adapter.ts';
import type { WorkflowToolSurfacePorts } from '../../src/app/workflow-tool-surface.ts';
import type { WorkflowStore } from '../../src/session/session-store.ts';
import type { SessionTransaction } from '../../src/app/session-executor.ts';
import type { LogFn } from '../../src/app/logger.ts';
import type { Reporter } from '../../src/app/report.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import { createSession } from '../../src/session/session-store.ts';

// ── Test helpers ──────────────────────────────────────────────────────────

type CapturedTool = Parameters<ToolEditor['add']>[0];

function createMockPorts(): WorkflowToolSurfacePorts {
  return {
    profilesDir: '/profiles',
    projectDir: '/project',
    store: {} as WorkflowStore,
    executor: {
      run: async <T>(_sessionID: string, action: (tx: SessionTransaction) => Promise<T>) =>
        action({ session: null, deferAfterSave: () => {} }),
    },
    mutationOrchestrator: {
      resolveEngine: async () => {
        throw new Error('Unexpected engine resolution in V2 tool surface fixture');
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
        throw new Error('Unexpected task status update in V2 tool surface fixture');
      },
    },
    sessionContext: {
      load: vi.fn(async () => null as WorkflowSession | null),
    },
    log: vi.fn(async () => {}) as LogFn,
    report: vi.fn(async () => {}) as Reporter,
  };
}

function fakeEditor(): {
  editor: ToolEditor;
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
  const editor: ToolEditor = {
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    add: (tool) => tools.push(tool),
    update: () => {},
    remove: () => {},
  };
  return {
    editor,
    tools,
  };
}

/** Run a V2 tool.execute and return its resolved output */
async function runTool(
  tool: CapturedTool,
  input: Record<string, unknown> = {},
  context: Parameters<CapturedTool['execute']>[1] = toolContext()
): Promise<{ output?: string; metadata?: unknown }> {
  return tool.execute(input, context);
}

function toolContext(): Parameters<CapturedTool['execute']>[1] {
  return {
    sessionID: Session.ID.create(),
    agent: Agent.ID.make('test'),
    messageID: SessionMessage.ID.create(),
    id: CallID.make('call-test'),
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('V2ToolSurfaceAdapter', () => {
  describe('public surface', () => {
    it('registers the complete stable public tool surface (8 tools)', () => {
      const ports = createMockPorts();
      const { editor, tools } = fakeEditor();

      registerWorkflowTools(editor, ports);

      expect(tools.map((t) => t.name)).toEqual([
        'workflow-list',
        'workflow-create',
        'workflow-consent',
        'workflow-tasks-set',
        'workflow-tasks-get',
        'workflow-tasks-set-status',
        'workflow-tasks-resolve-decision',
        'workflow-gate-set',
      ]);
    });

    // The promise ToolEditor hands `execute`'s return value to `Effect.promise`,
    // which calls `.then` on it; an Effect there is not a thenable and every
    // tool call dies with `… .then is not a function` before the tool runs.
    it('returns a Promise from execute, as the promise ToolEditor requires', async () => {
      const { editor, tools } = fakeEditor();
      registerWorkflowTools(editor, createMockPorts());

      const wl = tools.find((t) => t.name === 'workflow-list')!;
      const returned = wl.execute({}, toolContext());

      expect(returned).toBeInstanceOf(Promise);
      await expect(returned).resolves.toMatchObject({
        output: expect.stringContaining('profilesDir'),
      });
    });
  });

  describe('workflow-list', () => {
    it('returns an empty profile listing when no profiles exist', async () => {
      const { editor, tools } = fakeEditor();
      const ports = createMockPorts();

      registerWorkflowTools(editor, ports);

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
      registerWorkflowTools(editor, createMockPorts());

      for (const tool of tools) {
        expect(tool.input).toMatchObject({
          type: 'object',
          properties: expect.any(Object),
        });
      }
    });

    it('assigns a non-empty description to every tool', () => {
      const { editor, tools } = fakeEditor();
      registerWorkflowTools(editor, createMockPorts());

      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(5);
      }
    });

    // A result carrying `output` with no declared output schema is a runtime
    // error in V2 (`Tool result declared output without an output schema`), and
    // the model answers it by calling the tool again, forever.
    it('declares a string output schema for every tool', () => {
      const { editor, tools } = fakeEditor();
      registerWorkflowTools(editor, createMockPorts());

      for (const tool of tools) {
        expect(tool.output).toEqual({ type: 'string' });
      }
    });
  });

  describe('workflow-create', () => {
    it('returns profile-not-found when no profiles exist', async () => {
      const { editor, tools } = fakeEditor();
      const ports = createMockPorts();

      registerWorkflowTools(editor, ports);

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

      registerWorkflowTools(editor, ports);

      const wl = tools.find((t) => t.name === 'workflow-list')!;
      const result = await runTool(wl);
      // listProfiles handles missing directories and returns empty — the
      // tool should produce a normal output, not throw.
      expect(result.output).toContain('profilesDir: /nonexistent-path-12345');
      expect(result.output).toContain('(no profiles found)');
    });
  });
});
