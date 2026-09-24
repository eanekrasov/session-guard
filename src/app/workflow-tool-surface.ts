import type { ToolContext, ToolDefinition, ToolResult } from '@opencode-ai/plugin';
import { tool as toolFn } from '@opencode-ai/plugin';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import type { ProfileMetadata, StageDef } from '../schema/types.ts';
import { MutationTaskSchema, TASK_STATUS } from '../session/session-schema.ts';
import type { TaskApi, SetTasksInput } from './task-api.ts';
import type { WorkflowStore } from '../session/session-store.ts';
import type { SessionExecutor } from './session-executor.ts';
import type { MutationOrchestrator } from './mutation-orchestrator.ts';
import type { LogFn } from './logger.ts';
import { createReporter, errorMessage, type Reporter } from './report.ts';
import { agentIsAllowed } from './agent-names.ts';
import { canonicalizePlan, computeSha256 } from './sdd-artifacts.ts';
import { evidenceOf, type ConsentManifest } from './consent.ts';
import { listProfiles, resolveConfig } from '../public-api.ts';
import { schemaId } from './profile-resolver.ts';
import { selectSchema } from './mutation-orchestrator.ts';
import { createSession } from '../session/session-store.ts';
import { firstNestedStageId, nestedStages, ProfileConfigurationError } from '../schema/types.ts';
import type { SessionGuardEngine } from '../domain/engine.ts';
import {
  findTask,
  findPendingRetryContext,
  upsertActiveTaskContext,
  removeActiveTaskContext,
  setGateStatus,
} from '../session/helpers.ts';
import type {
  WorkflowSession,
  LoopRun,
  ActiveOperation,
  MutationTask,
} from '../session/session-schema.ts';
import { isOpenLoopRun, nextLoopRunId } from '../session/helpers.ts';

type SdkToolInput = Parameters<typeof toolFn>[0];

function tool<A extends Record<string, unknown>>(def: {
  description: string;
  args: A;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}): ToolDefinition {
  return toolFn(def as unknown as SdkToolInput);
}

export interface WorkflowToolSurfacePorts {
  profilesDir: string;
  projectDir: string;
  store: WorkflowStore;
  executor: SessionExecutor;
  mutationOrchestrator: MutationOrchestrator;
  consentOrchestrator: {
    before: (sessionID: string, callID: string, questionText: string) => Promise<void>;
    after: (
      sessionID: string,
      callID: string,
      args: unknown,
      output: { title: string; output: string; metadata: unknown }
    ) => Promise<void>;
  };
  taskApi: TaskApi;
  sessionContext: { load: (sessionID: string) => Promise<WorkflowSession | null> };
  log: LogFn;
  report: Reporter;
}

export interface WorkflowToolSurface {
  createTools(): Record<string, ToolDefinition>;
}

class WorkflowToolSurfaceImpl implements WorkflowToolSurface {
  private readonly ports: WorkflowToolSurfacePorts;

  constructor(ports: WorkflowToolSurfacePorts) {
    this.ports = ports;
  }

  createTools(): Record<string, ToolDefinition> {
    return {
      'workflow-create': tool({
        description: 'Create a new session-guard workflow session',
        args: {
          schemaId: z.string().optional().describe('Schema ID without .yaml (e.g., android)'),
        },
        execute: async (args: { schemaId?: string }, ctx: ToolContext) =>
          this.handleCreateWorkflow(args, ctx),
      }),
      'workflow-list': tool({
        description:
          'List all available workflow profiles (schemas). Returns profilesDir and profile IDs with descriptions.',
        args: {},
        execute: async () => this.handleWorkflowList(),
      }),
      'workflow-consent': tool({
        description:
          'Request file consent from the operator. Reads files from disk, ' +
          'computes integrity evidence, and prepares the session for a consent question. ' +
          'Call this BEFORE asking the user with the `question` tool.',
        args: {
          files: z
            .union([z.array(z.string()).min(1), z.string().min(1)])
            .describe('Paths to files (e.g. [".opencode/plan.md"])'),
          summary: z.string().min(1).max(400).describe('Short summary of what the file proposes'),
          type: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Which consent this is, by the name the schema uses on its transition ' +
                "(`consent: <name>`). Defaults to 'plan'."
            ),
          grant: z.string().default('grant').describe('Label for the approve option'),
          decline: z.string().default('decline').describe('Label for the decline option'),
        },
        execute: async (
          args: {
            files: string[];
            summary: string;
            type?: string;
            grant?: string;
            decline?: string;
          },
          ctx: ToolContext
        ) => this.handleWorkflowConsent(args, ctx),
      }),
      'workflow-tasks-set': tool({
        description:
          'Replace a workflow task list. Without listKey the list is the one the run in ' +
          'flight is cycling over, or the single list this workflow declares; a workflow ' +
          'declaring several asks for the name. ' +
          'Cannot replace a list while work is in progress. IDs are auto-assigned.',
        args: {
          listKey: z.string().min(1).optional(),
          tasks: z.union([z.array(MutationTaskSchema.omit({ id: true })), z.string().min(1)]),
        },
        execute: async (
          args: { tasks: Omit<SetTasksInput['tasks'][number], 'id'>[] | string; listKey?: string },
          ctx: ToolContext
        ) => this.handleTasksSet(args, ctx),
      }),
      'workflow-tasks-get': tool({
        description: 'Read one named workflow task list',
        args: { listKey: z.string().min(1) },
        execute: async (args: { listKey: string }, ctx: ToolContext) =>
          this.handleTasksGet(args, ctx),
      }),
      'workflow-tasks-set-status': tool({
        description: 'Set a workflow task status by global task ID',
        args: { taskId: z.string().regex(/^task-[0-9]+$/), status: z.enum(TASK_STATUS) },
        execute: async (
          args: { taskId: string; status: (typeof TASK_STATUS)[number] },
          ctx: ToolContext
        ) => this.handleTasksSetStatus(args, ctx),
      }),
      'workflow-tasks-resolve-decision': tool({
        description:
          'Resolve a pending workflow task retry decision. ' +
          'Accepts an optional decisionId selector. Without it, selects the single unique pending retry context; ' +
          'if zero or multiple are found, outputs diagnostic candidate IDs without mutating.',
        args: {
          decision: z.enum(['increase', 'failed', 'cancelled']),
          maximum: z.number().int().min(1).optional(),
          decisionId: z.string().optional(),
        },
        execute: async (
          args: {
            decision: 'increase' | 'failed' | 'cancelled';
            maximum?: number;
            decisionId?: string;
          },
          ctx: ToolContext
        ) => this.handleTasksResolveDecision(args, ctx),
      }),
    };
  }

  private async handleCreateWorkflow(
    args: { schemaId?: string },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    const requested = args.schemaId ?? process.env.HARNESS_SCHEMA_ID ?? process.env.HARNESS_PROFILE;

    const slash = requested?.indexOf('/') ?? -1;
    const requestedProfileId = slash === -1 ? requested : requested!.substring(0, slash);
    const requestedSchemaId = slash === -1 ? undefined : requested!.substring(slash + 1);

    const profiles = await listProfiles(this.ports.profilesDir);
    const resolvedProfileId = profiles.some((profile) => profile.id === requestedProfileId)
      ? requestedProfileId
      : undefined;

    if (!resolvedProfileId) {
      if (profiles.length === 0) {
        const message =
          `No workflow profiles found in ${this.ports.profilesDir}. ` +
          `Set SESSION_GUARD_PROFILES_DIR or create a profile to use workflow tools.`;
        this.ports.report(message, { profilesDir: this.ports.profilesDir });
        return { output: message };
      }
      return {
        output: `schemaId is required or unknown. Available: ${profiles
          .flatMap((profile) =>
            (profile.schemas ?? []).map((file) => `${profile.id}/${schemaId(file)}`)
          )
          .join(', ')}`,
      };
    }

    const existing = await this.ports.store.load(ctx.sessionID);
    if (existing) {
      return { output: `Session already exists: ${ctx.sessionID}` };
    }

    let resolvedSchemaId: string;
    let engine: SessionGuardEngine;
    try {
      const resolved = await resolveConfig(resolvedProfileId, this.ports.profilesDir);
      resolvedSchemaId = selectSchema(resolvedProfileId, resolved.schemas, requestedSchemaId).id;
      engine = await this.ports.mutationOrchestrator.resolveEngine(
        resolvedProfileId,
        resolvedSchemaId
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix =
        error instanceof ProfileConfigurationError
          ? 'Profile configuration error'
          : 'Profile resolution error';
      return { output: `${prefix}: ${message}` };
    }

    const session = createSession(
      ctx.sessionID,
      resolvedProfileId,
      resolvedSchemaId,
      engine.getInitialStage()
    );
    await this.ports.store.save(session);

    void this.ports.log('info', `Workflow session created`, {
      sessionID: session.sessionId,
      profileId: resolvedProfileId,
      schemaId: resolvedSchemaId,
    });

    return {
      output: `Created session ${session.sessionId} with profile ${resolvedProfileId}`,
      metadata: {
        sessionId: session.sessionId,
        profileId: resolvedProfileId,
        schemaVersion: session.schemaVersion,
        revision: session.revision,
      },
    };
  }

  private async handleWorkflowList(): Promise<ToolResult> {
    const profiles = await listProfiles(this.ports.profilesDir);
    return { output: formatWorkflowList(this.ports.profilesDir, profiles) };
  }

  private async handleWorkflowConsent(
    args: {
      files: string[];
      summary: string;
      type?: string;
      grant?: string;
      decline?: string;
    },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    const session = await this.ports.sessionContext.load(ctx.sessionID);
    if (!session) {
      return { output: 'No workflow session found. Call workflow-create first.' };
    }

    let filesInput: string | string[] = args.files;
    if (typeof filesInput === 'string') {
      try {
        const parsed = JSON.parse(filesInput);
        if (Array.isArray(parsed)) filesInput = parsed;
      } catch {
        // ignore — treat as plain string path
      }
    }
    const files = Array.isArray(filesInput) ? filesInput : [filesInput];

    const fileContents: string[] = [];
    for (const file of files) {
      const absolute = resolve(this.ports.projectDir, file);
      if (!existsSync(absolute)) {
        return { output: `File not found: ${file}` };
      }
      const content = readFileSync(absolute, 'utf-8');
      fileContents.push(canonicalizePlan(content));
    }

    const primaryContent = fileContents[0];
    const consentEvidence = computeSha256(primaryContent);

    const revision = session.revision;

    const manifest: ConsentManifest = {
      schema: 'harness.consent.evidence/v1' as const,
      revision,
      summary: args.summary,
      files: args.files,
      ...(args.type ? { type: args.type } : {}),
    };
    const manifestEvidence = evidenceOf(manifest);

    await this.ports.store.save(session);

    void this.ports.log('info', 'workflow-consent: consent request prepared', {
      sessionID: ctx.sessionID,
      summary: args.summary,
      files: args.files,
      evidence: consentEvidence.slice(0, 16),
    });

    const grantLabel = args.grant ?? 'grant';
    const declineLabel = args.decline ?? 'decline';

    const consentTag =
      `<consent-request schema="harness.consent/v1" revision="${revision}" ` +
      `evidence="${manifestEvidence}" grant="${grantLabel}" ` +
      `decline="${declineLabel}">` +
      `${JSON.stringify(manifest)}` +
      `</consent-request>`;

    return {
      output:
        `Consent request prepared for files at ${files}. ` +
        `Evidence: ${consentEvidence.slice(0, 16)}...\n` +
        `IMPORTANT: You MUST call question() NOW and include this consent tag in the question text. ` +
        `Do NOT continue without asking the user — this is a blocking consent step:\n` +
        consentTag,
      metadata: {
        consentTag,
        evidence: consentEvidence,
        revision: session.revision,
        summary: args.summary,
      },
    };
  }

  private async handleTasksSet(
    args: { tasks: Omit<SetTasksInput['tasks'][number], 'id'>[] | string; listKey?: string },
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult> {
    const refusal = await this.refuseUnlessTaskController('workflow-tasks-set', ctx);
    if (refusal) return refusal;
    try {
      let tasksInput: Omit<SetTasksInput['tasks'][number], 'id'>[];
      if (typeof args.tasks === 'string') {
        try {
          const parsed = JSON.parse(args.tasks);
          tasksInput = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return { output: `Invalid tasks JSON string: ${args.tasks}` };
        }
      } else {
        tasksInput = args.tasks;
      }

      return await this.ports.executor.run(ctx.sessionID, async (tx) => {
        if (!tx.session) {
          return { output: 'No workflow session found. Call workflow-create first.' } as ToolResult;
        }

        const activeRun = Object.values(tx.session.loopRuns).find(
          (run) => run.status === 'running' || run.status === 'awaiting_decision'
        );
        let listKey = args.listKey ?? activeRun?.listKey;
        if (listKey === undefined) {
          const declared = await this.declaredTaskLists(tx.session.profileId, tx.session.schemaId);
          if (declared.length === 1) {
            listKey = declared[0]!;
          } else {
            return {
              output:
                declared.length === 0
                  ? `${tx.session.profileId}/${tx.session.schemaId} declares no task list to fill: no stage names a \`loop:\` source.`
                  : `listKey is required: ${tx.session.profileId}/${tx.session.schemaId} declares [${declared.join(', ')}].`,
            } as ToolResult;
          }
        }

        const maxExisting = Object.values(tx.session.tasks)
          .flat()
          .reduce((max, t) => {
            const num = parseInt(t.id.replace('task-', ''), 10);
            return num > max ? num : max;
          }, -1);

        const tasksWithIds = tasksInput.map((task, i) => ({
          ...task,
          id: `task-${maxExisting + 1 + i}`,
        }));

        const tasks = await this.ports.taskApi.setTasks(ctx.sessionID, {
          listKey,
          tasks: tasksWithIds,
        });
        return {
          output: `Stored ${tasks.length} task(s) in ${listKey}`,
          metadata: { sessionId: ctx.sessionID, listKey, taskCount: tasks.length },
        } as ToolResult;
      });
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleTasksGet(
    args: { listKey: string },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    try {
      const tasks = await this.ports.taskApi.getTasks(ctx.sessionID, args.listKey);
      return {
        output: `${args.listKey}: ${tasks.length} task(s)`,
        metadata: { sessionId: ctx.sessionID, listKey: args.listKey, tasks },
      };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleTasksSetStatus(
    args: { taskId: string; status: (typeof TASK_STATUS)[number] },
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult> {
    const refusal = await this.refuseUnlessTaskController('workflow-tasks-set-status', ctx);
    if (refusal) return refusal;
    try {
      const task = await this.ports.taskApi.setTaskStatus(ctx.sessionID, args.taskId, args.status);
      return {
        output: `Updated ${task.id} to ${task.status}`,
        metadata: { sessionId: ctx.sessionID, taskId: task.id, status: task.status },
      };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleTasksResolveDecision(
    args: { decision: 'increase' | 'failed' | 'cancelled'; maximum?: number; decisionId?: string },
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult> {
    const refusal = await this.refuseUnlessTaskController('workflow-tasks-resolve-decision', ctx);
    if (refusal) return refusal;
    try {
      let output = 'No pending retry decision found';
      await this.ports.executor.run(ctx.sessionID, async (tx) => {
        if (!tx.session) {
          output = `Unknown workflow session: ${ctx.sessionID}`;
          return;
        }

        const pendingCtx = findPendingRetryContext(tx.session, args.decisionId);
        if (!pendingCtx) {
          if (args.decisionId) {
            output = `No pending retry decision found for decisionId "${args.decisionId}"`;
          } else {
            const candidates = (tx.session.pendingDecisions ?? [])
              .filter((d) => d.status === 'pending')
              .map((d) => `  - ${d.id} (${d.subject} ${d.subjectId}: ${d.kind})`);
            if (candidates.length > 0) {
              output = `No unique pending retry context. Candidate decision IDs:\n${candidates.join('\n')}`;
            } else {
              output = 'No pending decisions found';
            }
          }
          return;
        }

        const { taskId, decision, run } = pendingCtx;

        if (decision.status !== 'pending' || decision.kind !== 'retry_exhausted') {
          output = `Decision ${decision.id} is not a pending retry_exhausted decision (status=${decision.status}, kind=${decision.kind})`;
          return;
        }

        if (decision.runId && decision.runId !== run.id) {
          output = `Decision ${decision.id} references run ${decision.runId} but resolved to ${run.id}`;
          return;
        }

        const task = findTask(tx.session, taskId);
        if (!task) {
          output = `Task ${taskId} not found`;
          return;
        }

        if (run.status !== 'awaiting_decision') {
          output = `Run ${run.id} (task ${taskId}) is not awaiting decision (status=${run.status})`;
          return;
        }

        const budget = tx.session.retryBudgets[taskId];
        if (!budget) {
          output = `No retry budget for ${taskId}`;
          return;
        }

        if (args.decision === 'increase') {
          if (args.maximum === undefined || args.maximum <= budget.attempts) {
            output = `New retry maximum for ${taskId} must be greater than ${budget.attempts}`;
            return;
          }
          budget.maximum = args.maximum;
          const stage = await this.resolveLoopStage(tx.session, run.listKey);
          run.stage = firstNestedStageId(stage) ?? run.stage;
          run.status = 'running';
          task.status = 'running';
          this.upsertActiveTaskContextFromSession(tx.session, run.id, 'running');
          output = `Increased retry maximum for ${taskId} to ${args.maximum}`;
        } else {
          run.status = args.decision;
          task.status = args.decision;
          removeActiveTaskContext(tx.session, run.id);
          output =
            args.decision === 'failed'
              ? `Failed ${taskId} after retry decision`
              : `Cancelled ${taskId} after retry decision`;
        }

        this.clearPendingDecision(tx.session, decision.id);
      });
      return { output };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  }

  private async refuseUnlessTaskController(
    toolName: string,
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult | null> {
    const session = await this.ports.sessionContext.load(ctx.sessionID);
    if (!session) return null;

    let allowed: string[];
    try {
      const engine = await this.ports.mutationOrchestrator.resolveEngine(
        session.profileId,
        session.schemaId
      );
      allowed = engine.getTaskControlAgents();
    } catch (error) {
      const message = `${toolName} is refused: ${errorMessage(error)}`;
      this.ports.report(message, { sessionID: ctx.sessionID, tool: toolName });
      return { output: message, metadata: { refused: true, tool: toolName } };
    }
    const agent = ctx.agent ?? '';
    if (agent !== '' && agentIsAllowed(agent, allowed, session.profileId)) return null;

    const reason =
      `${toolName} is refused: workflow task state is controlled by ` +
      `[${allowed.join(', ')}], not by '${agent || '(unknown agent)'}'. ` +
      `Report the outcome of your work instead — the orchestrator records it.`;
    void this.ports.log('warn', `Refused ${toolName}`, {
      sessionID: ctx.sessionID,
      agent: agent || null,
      allowed,
    });
    return { output: reason, metadata: { refused: true, tool: toolName, agent, allowed } };
  }

  private async declaredTaskLists(profileId: string, schemaId?: string): Promise<string[]> {
    const profile = await resolveConfig(profileId, this.ports.profilesDir);
    const schema = selectSchema(profileId, profile.schemas, schemaId);
    return Object.values(schema.stages ?? {})
      .map((stage: { loop?: string }) => stage.loop)
      .filter((loop): loop is string => loop !== undefined && loop !== '$currentTask.id');
  }

  private async resolveLoopStage(
    session: WorkflowSession,
    listKey: string
  ): Promise<StageDef | null> {
    const engine = await this.ports.mutationOrchestrator.resolveEngine(
      session.profileId,
      session.schemaId
    );
    return engine.getLoopStage(listKey);
  }

  private upsertActiveTaskContextFromSession(
    session: WorkflowSession,
    runId: string,
    status: 'running' | 'awaiting_decision'
  ): void {
    const existing = session.activeTaskContexts.find((a) => a.runId === runId);
    const agent = existing?.agent ?? '';
    upsertActiveTaskContext(
      session,
      { runId, taskId: existing?.taskId ?? '', agent, status },
      new Date().toISOString()
    );
  }

  private clearPendingDecision(session: WorkflowSession, decisionId: string): void {
    session.pendingDecisions = (session.pendingDecisions ?? []).filter(
      (decision) => decision.id !== decisionId
    );
  }
}

export function createWorkflowToolSurface(ports: WorkflowToolSurfacePorts): WorkflowToolSurface {
  return new WorkflowToolSurfaceImpl(ports);
}

export function formatWorkflowList(
  profilesDir: string,
  profiles: Awaited<ReturnType<typeof listProfiles>>
): string {
  const lines = [`profilesDir: ${profilesDir}`];
  for (const profile of profiles) {
    const parts: string[] = [profile.id];
    if (profile.description) parts.push(`desc: ${profile.description}`);
    if (profile.extends) parts.push(`extends: ${profile.extends}`);
    if (profile.schemas && profile.schemas.length > 0)
      parts.push(`schemas: ${profile.schemas.join(', ')}`);
    lines.push(`  - ${parts.join(' | ')}`);
  }
  if (profiles.length === 0) lines.push('  (no profiles found)');
  return lines.join('\n');
}
