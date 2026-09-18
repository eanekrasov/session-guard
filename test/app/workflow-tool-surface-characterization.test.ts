import { describe, expect, it } from 'vitest';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'tool-surface',
      name: 'tool-surface',
      directory: '/tmp/tool-surface',
      worktree: '/tmp/tool-surface',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/tool-surface',
    worktree: '/tmp/tool-surface',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

type Tool = {
  description: string;
  args: Record<string, { _def?: Record<string, unknown> }>;
  execute: (...args: unknown[]) => Promise<unknown>;
};

function tools(): Record<string, Tool> {
  return (createRuntime(pluginInput()) as Hooks & { tool?: Record<string, Tool> }).tool ?? {};
}

function schemaShape(tool: Tool): Record<string, { typeName: unknown; description?: unknown }> {
  return Object.fromEntries(
    Object.entries(tool.args).map(([name, schema]) => [
      name,
      {
        typeName: schema._def?.typeName,
        description: schema._def?.description,
      },
    ])
  );
}

describe('workflow tool surface characterization', () => {
  it('preserves every public workflow tool, description, schema key, and callback', () => {
    const registered = tools();

    expect(Object.keys(registered)).toEqual([
      'workflow-create',
      'workflow-list',
      'workflow-consent',
      'workflow-tasks-set',
      'workflow-tasks-get',
      'workflow-tasks-set-status',
      'workflow-tasks-resolve-decision',
    ]);

    expect(
      Object.fromEntries(
        Object.entries(registered).map(([name, tool]) => [
          name,
          {
            description: tool.description,
            argumentNames: Object.keys(tool.args),
            hasExecuteCallback: typeof tool.execute === 'function',
          },
        ])
      )
    ).toEqual({
      'workflow-create': {
        description: 'Create a new session-guard workflow session',
        argumentNames: ['schemaId'],
        hasExecuteCallback: true,
      },
      'workflow-list': {
        description:
          'List all available workflow profiles (schemas). Returns profilesDir and profile IDs with descriptions.',
        argumentNames: [],
        hasExecuteCallback: true,
      },
      'workflow-consent': {
        description:
          'Request file consent from the operator. Reads files from disk, computes integrity evidence, and prepares the session for a consent question. Call this BEFORE asking the user with the `question` tool.',
        argumentNames: ['files', 'summary', 'type', 'grant', 'decline'],
        hasExecuteCallback: true,
      },
      'workflow-tasks-set': {
        description:
          'Replace a workflow task list. Without listKey the list is the one the run in flight is cycling over, or the single list this workflow declares; a workflow declaring several asks for the name. Cannot replace a list while work is in progress. IDs are auto-assigned.',
        argumentNames: ['listKey', 'tasks'],
        hasExecuteCallback: true,
      },
      'workflow-tasks-get': {
        description: 'Read one named workflow task list',
        argumentNames: ['listKey'],
        hasExecuteCallback: true,
      },
      'workflow-tasks-set-status': {
        description: 'Set a workflow task status by global task ID',
        argumentNames: ['taskId', 'status'],
        hasExecuteCallback: true,
      },
      'workflow-tasks-resolve-decision': {
        description:
          'Resolve a pending workflow task retry decision. Accepts an optional decisionId selector. Without it, selects the single unique pending retry context; if zero or multiple are found, outputs diagnostic candidate IDs without mutating.',
        argumentNames: ['decision', 'maximum', 'decisionId'],
        hasExecuteCallback: true,
      },
    });
  });

  it('preserves the compatibility alias and the meaningful Zod schema contracts', () => {
    const registered = tools();

    // The original public name is itself the compatibility alias; it must not
    // silently become a renamed or unregistered tool during extraction.
    expect(registered['workflow-create']).toBeDefined();
    expect(schemaShape(registered['workflow-create']!)).toEqual({
      schemaId: { typeName: 'ZodOptional', description: 'Schema ID without .yaml (e.g., android)' },
    });
    expect(schemaShape(registered['workflow-tasks-set-status']!)).toEqual({
      taskId: { typeName: 'ZodString' },
      status: { typeName: 'ZodEnum' },
    });
    expect(schemaShape(registered['workflow-tasks-resolve-decision']!)).toEqual({
      decision: { typeName: 'ZodEnum' },
      maximum: { typeName: 'ZodOptional' },
      decisionId: { typeName: 'ZodOptional' },
    });
  });
});
