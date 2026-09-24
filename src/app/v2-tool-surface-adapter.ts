import { Effect } from 'effect';
import { Tool } from '@opencode/schema/tool';
import type { ToolEditor } from '@opencode/plugin/promise/tool';
import type { ToolDefinition } from '@opencode-ai/plugin';
import { errorMessage } from './report.ts';
import {
  createWorkflowToolSurface,
  type WorkflowToolSurface,
  type WorkflowToolSurfacePorts,
} from './workflow-tool-surface.ts';

const descriptions: Record<string, string> = {
  'workflow-list':
    'List all available workflow profiles (schemas). Returns profilesDir and profile IDs with descriptions.',
  'workflow-create': 'Create a new session-guard workflow session',
  'workflow-consent':
    'Request file consent from the operator. Reads files from disk, computes integrity evidence, and prepares the session for a consent question.',
  'workflow-tasks-set': 'Replace a workflow task list. IDs are auto-assigned.',
  'workflow-tasks-get': 'Read one named workflow task list',
  'workflow-tasks-set-status': 'Set a workflow task status by global task ID',
  'workflow-tasks-resolve-decision': 'Resolve a pending workflow task retry decision.',
};

const inputs: Record<string, Record<string, unknown>> = {
  'workflow-list': { type: 'object', properties: {}, additionalProperties: false },
  'workflow-create': {
    type: 'object',
    properties: {
      schemaId: { type: 'string', description: 'Schema ID without .yaml' },
    },
    additionalProperties: false,
  },
  'workflow-consent': {
    type: 'object',
    properties: {
      files: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      summary: { type: 'string', minLength: 1, maxLength: 400 },
      type: { type: 'string' },
      grant: { type: 'string', default: 'grant' },
      decline: { type: 'string', default: 'decline' },
    },
    additionalProperties: false,
  },
  'workflow-tasks-set': {
    type: 'object',
    properties: {
      listKey: { type: 'string' },
      tasks: { oneOf: [{ type: 'array' }, { type: 'string', minLength: 1 }] },
    },
    additionalProperties: false,
  },
  'workflow-tasks-get': {
    type: 'object',
    properties: { listKey: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  'workflow-tasks-set-status': {
    type: 'object',
    properties: {
      taskId: { type: 'string', pattern: '^task-[0-9]+$' },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'blocked'],
      },
    },
    additionalProperties: false,
  },
  'workflow-tasks-resolve-decision': {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['increase', 'failed', 'cancelled'] },
      maximum: { type: 'number' },
      decisionId: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const toolOrder = [
  'workflow-list',
  'workflow-create',
  'workflow-consent',
  'workflow-tasks-set',
  'workflow-tasks-get',
  'workflow-tasks-set-status',
  'workflow-tasks-resolve-decision',
] as const;

function runTool(
  surface: WorkflowToolSurface,
  name: string,
  input: unknown,
  context: unknown
): Promise<{ output?: string; metadata?: unknown }> {
  const definition = surface.createTools()[name] as ToolDefinition & {
    execute: (args: unknown, ctx: unknown) => Promise<{ output?: string; metadata?: unknown }>;
  };
  const ctx = context as { sessionID: string; agent?: string };
  return definition.execute(input, ctx);
}

/** Register the shared V1 behavior through V2 JSON-schema tool definitions. */
export function registerWorkflowTools(
  editor: ToolEditor,
  surfaceOrPorts: WorkflowToolSurface | WorkflowToolSurfacePorts
): void {
  const surface =
    'createTools' in surfaceOrPorts ? surfaceOrPorts : createWorkflowToolSurface(surfaceOrPorts);
  for (const name of toolOrder) {
    editor.add({
      name,
      description: descriptions[name],
      input:
        name === 'workflow-create'
          ? {
              type: 'object',
              properties: { schemaId: { type: 'string', description: 'Schema ID without .yaml' } },
              additionalProperties: false,
            }
          : inputs[name],
      execute: (input: unknown, context: unknown) =>
        Effect.tryPromise({
          try: () => runTool(surface, name, input, context),
          catch: (error) => new Tool.Error({ message: `[ERROR] ${errorMessage(error)}` }),
        }),
    } as never);
  }
}
