import { spawnSync } from 'node:child_process';
import type {
  Config,
  Hooks,
  PluginInput,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@opencode-ai/plugin';
import { tool as toolFn } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createSession, WorkflowStore } from '../session/session-store.ts';
import {
  firstNestedStageId,
  nestedStages,
  ProfileConfigurationError,
  type StageDef,
  type TransitionDef,
} from '../schema/types.ts';
import { nextTaskStage, TASK_DONE } from '../domain/task-movement.ts';
import { approve } from '../domain/approvals.ts';
import { toGuardContext } from '../domain/engine.ts';
import { SessionQueue } from './session-queue.ts';
import { sanitizeToolOutput, validateUserInput } from './guardrails.ts';
import { listProfiles } from '../public-api.ts';
import { mergeSchemasToEngineConfig, MutationOrchestrator } from './mutation-orchestrator.ts';
import { ConsentOrchestrator } from './consent-orchestrator.ts';
import { parseWorkflowResult } from '../domain/evidence.ts';
import type { LogFn } from './logger.ts';
import { createLogFn } from './logger.ts';
import {
  canCommit,
  extractBashCommand,
  hasForbiddenGitSubcommand,
  isCommitTaskCommand,
} from '../domain/session-queries.ts';
import {
  isOpenLoopRun,
  findTask,
  nextLoopRunId,
  upsertActiveTaskContext,
  removeActiveTaskContext,
  findPendingRetryContext,
  setGateStatus,
} from '../session/helpers.ts';
import {
  TASK_STATUS,
  type LoopRun,
  type MutationTask,
  type WorkflowSession,
} from '../session/session-schema.ts';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { validateFilesForProfile, SUPPORTED_EXTENSIONS } from './invariants.ts';
import { parseConsentRequest, evidenceOf, type ConsentManifest } from './consent.ts';
import { canonicalizePlan, computeSha256 } from './sdd-artifacts.ts';
import { TaskApi, type SetTasksInput } from './task-api.ts';
import { resolveConfig } from '../public-api.ts';
import { sessionsDir, profilesDir as getProfilesDir } from './paths.ts';
import { OpenCodeRulesRuntime } from '../rules/runtime.ts';
import { MatchedRulesStateStore } from '../rules/matched-rules-state.ts';
import { syncProfileAgents } from './profile-agent-sync.ts';
import { agentIsAllowed } from './agent-names.ts';
import { WorkflowBlockedError } from './blocked-error.ts';

export { mergeSchemasToEngineConfig };

const DEFAULT_TASK_RETRY_MAXIMUM = 3;
const RETRY_EXHAUSTED_DECISION_KIND = 'retry_exhausted';

// Wrapper around the SDK's tool() that bridges the zod v3↔v4 type gap.
// The SDK uses zod v4 internally; our project uses zod v3.  This wrapper
// strips the generic so consumers get proper runtime behaviour without
// a cross-version zod TypeError at build time.
function tool<A extends Record<string, unknown>>(def: {
  description: string;
  args: A;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}): ToolDefinition {
  return toolFn(def as never);
}

// ─── StateMachineRuntime ─────────────────────────────────────────────────────

/** A tool part as it arrives on the event stream, in either host shape. */
interface EventPart {
  id?: string;
  status?: string;
  callID?: string;
  state?: { status?: string };
}

interface EventEnvelope {
  event: {
    type: string;
    message?: { id: string; parts?: EventPart[] };
    /** Legacy flat shape. */
    part?: EventPart;
    /** The shape OpenCode actually emits. */
    properties?: { part?: EventPart } & Record<string, unknown>;
  };
}

class StateMachineRuntime {
  private store: WorkflowStore;
  private queue: SessionQueue;
  private mutationOrchestrator: MutationOrchestrator;
  private consentOrchestrator: ConsentOrchestrator;
  private taskApi: TaskApi;
  private context: PluginInput;
  private log: LogFn;
  private rulesRuntime: OpenCodeRulesRuntime;
  private readonly fileTools = new Set(['edit', 'write', 'apply_patch']);
  /**
   * Tools that change the repository, and therefore run under the mutation
   * lifecycle: the plan approval is checked, invariants are re-run, and the
   * change scope is recorded. `edit` and `apply_patch` write files exactly as
   * `write` does — leaving them out let an agent edit a file it was not allowed
   * to create.
   */
  private readonly mutatingTools = new Set(['bash', 'write', 'edit', 'apply_patch']);
  private readonly profilesDir: string;
  private readonly projectDir: string;

  /**
   * The plugin is opt-in per session: until a workflow session exists, none of
   * its mechanics apply — guardrails and rules included. Every host hook that
   * carries a session id gates on this before doing any work.
   */
  private async hasWorkflowSession(sessionID: string | undefined): Promise<boolean> {
    if (!sessionID) return false;
    return (await this.store.load(sessionID)) !== null;
  }

  /**
   * Normalize tool identifiers to lowercase for consistent comparison.
   * SDK may send tool names in any casing (Bash, bash, BASH).
   */
  private normalizeTool(tool: string): string {
    return tool.toLowerCase();
  }

  constructor(context: PluginInput) {
    this.context = context;
    this.log = createLogFn(context.client);
    const storeDir = sessionsDir(context.directory);
    this.store = new WorkflowStore(storeDir, this.log);
    this.queue = new SessionQueue(this.store, this.log);

    this.profilesDir = getProfilesDir(context.directory);
    this.projectDir = context.directory;

    this.mutationOrchestrator = new MutationOrchestrator(
      this.store,
      this.queue,
      this.projectDir,
      this.profilesDir,
      this.log,
      context.client.session
    );
    this.consentOrchestrator = new ConsentOrchestrator(
      this.store,
      this.queue,
      this.projectDir,
      this.profilesDir,
      context.client.session,
      this.log
    );
    this.taskApi = new TaskApi(
      this.store,
      async (profileId) => {
        const profileRoot = this.profilesDir;
        const profile = await resolveConfig(profileId, profileRoot);
        return profile.schemas.flatMap((schema) =>
          Object.values(schema.stages ?? {})
            .map((stage) => stage.loop)
            .filter((loop): loop is string => loop !== undefined && loop !== '$currentTask.id')
        );
      },
      this.queue
    );

    // Initialize the rules sub-system — rule files are discovered lazily
    // inside OpenCodeRulesRuntime on first use.
    const matchedRulesStateStore = new MatchedRulesStateStore();
    this.rulesRuntime = new OpenCodeRulesRuntime({
      client: context.client,
      directory: context.directory,
      projectDirectory: context.directory,
      matchedRulesStateStore,
    });
  }

  /**
   * Workflow task state is orchestrator-owned.
   *
   * Task status is exactly what `allTasksCompleted()` and `hasPendingTasks()`
   * read, so an agent able to write it closes its own stage — evidence-free,
   * the same hole the delivery permit closes on the commit side. The host
   * reports the calling agent in `ToolContext.agent`; anything outside the
   * schema's `taskControlAgents` (default `['orchestrator']`) is refused, and
   * an unknown caller is refused too: identity we cannot read is not identity
   * we can trust.
   *
   * Returns a refusal result, or `null` when the call may proceed.
   */
  private async refuseUnlessTaskController(
    toolName: string,
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult | null> {
    // No workflow session means the plugin does not apply at all.
    const session = await this.store.load(ctx.sessionID);
    if (!session) return null;

    const engine = await this.mutationOrchestrator.resolveEngine(session.profileId);
    const allowed = engine.getTaskControlAgents();
    const agent = ctx.agent ?? '';
    if (agent !== '' && agentIsAllowed(agent, allowed, session.profileId)) return null;

    const reason =
      `${toolName} is refused: workflow task state is controlled by ` +
      `[${allowed.join(', ')}], not by '${agent || '(unknown agent)'}'. ` +
      `Report the outcome of your work instead — the orchestrator records it.`;
    void this.log('warn', `Refused ${toolName}`, {
      sessionID: ctx.sessionID,
      agent: agent || null,
      allowed,
    });
    return { output: reason, metadata: { refused: true, tool: toolName, agent, allowed } };
  }

  private async handleTasksSet(
    args: { tasks: Omit<SetTasksInput['tasks'][number], 'id'>[] | string },
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult> {
    const refusal = await this.refuseUnlessTaskController('workflow.tasks-set', ctx);
    if (refusal) return refusal;
    try {
      // Normalize tasks: if string, parse as JSON array
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

      // Move listKey resolution and ID computation into the queue scope
      // so they see consistent state with the setTasks call
      const result = await this.queue.enqueue(ctx.sessionID, async (session) => {
        if (!session) {
          return { output: 'No workflow session found. Call workflow.create first.' } as ToolResult;
        }

        // Determine listKey from active loop runs, fallback to 'implementation'
        const activeRun = Object.values(session.loopRuns).find(
          (run) => run.status === 'running' || run.status === 'awaiting_decision'
        );
        const listKey = activeRun?.listKey ?? 'implementation';

        // Compute next available task ID across all existing lists
        const maxExisting = Object.values(session.tasks)
          .flat()
          .reduce((max, t) => {
            const num = parseInt(t.id.replace('task-', ''), 10);
            return num > max ? num : max;
          }, -1);

        // Assign IDs to incoming tasks
        const tasksWithIds = tasksInput.map((task, i) => ({
          ...task,
          id: `task-${maxExisting + 1 + i}`,
        }));

        const tasks = await this.taskApi.setTasks(ctx.sessionID, {
          listKey,
          tasks: tasksWithIds,
        });
        return {
          output: `Stored ${tasks.length} task(s) in ${listKey}`,
          metadata: { sessionId: ctx.sessionID, listKey, taskCount: tasks.length },
        } as ToolResult;
      });

      return result;
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleTasksGet(
    args: { listKey: string },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    try {
      const tasks = await this.taskApi.getTasks(ctx.sessionID, args.listKey);
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
    const refusal = await this.refuseUnlessTaskController('workflow.tasks-set-status', ctx);
    if (refusal) return refusal;
    try {
      const task = await this.taskApi.setTaskStatus(ctx.sessionID, args.taskId, args.status);
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
    const refusal = await this.refuseUnlessTaskController('workflow.tasks-resolve-decision', ctx);
    if (refusal) return refusal;
    try {
      let output = 'No pending retry decision found';
      await this.queue.enqueue(ctx.sessionID, async (session) => {
        if (!session) {
          output = `Unknown workflow session: ${ctx.sessionID}`;
          return;
        }

        const pendingCtx = findPendingRetryContext(session, args.decisionId);
        if (!pendingCtx) {
          if (args.decisionId) {
            output = `No pending retry decision found for decisionId "${args.decisionId}"`;
          } else {
            const candidates = (session.pendingDecisions ?? [])
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

        // Verify decision exists, is pending, kind retry_exhausted
        if (decision.status !== 'pending' || decision.kind !== 'retry_exhausted') {
          output = `Decision ${decision.id} is not a pending retry_exhausted decision (status=${decision.status}, kind=${decision.kind})`;
          return;
        }

        // Resolve the run through decision.runId, not first run matching taskId
        if (decision.runId && decision.runId !== run.id) {
          output = `Decision ${decision.id} references run ${decision.runId} but resolved to ${run.id}`;
          return;
        }

        // Verify run, task, and budget agree
        const task = findTask(session, taskId);
        if (!task) {
          output = `Task ${taskId} not found`;
          return;
        }

        if (run.status !== 'awaiting_decision') {
          output = `Run ${run.id} (task ${taskId}) is not awaiting decision (status=${run.status})`;
          return;
        }

        const budget = session.retryBudgets[taskId];
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
          const stage = await this.resolveLoopStage(session.profileId, run.listKey);
          run.stage = firstNestedStageId(stage) ?? run.stage;
          run.status = 'running';
          task.status = 'running';
          this.upsertActiveTaskContextFromSession(session, run.id, 'running');
          output = `Increased retry maximum for ${taskId} to ${args.maximum}`;
        } else {
          run.status = args.decision;
          task.status = args.decision;
          removeActiveTaskContext(session, run.id);
          output =
            args.decision === 'failed'
              ? `Failed ${taskId} after retry decision`
              : `Cancelled ${taskId} after retry decision`;
        }

        this.clearPendingDecision(session, decision.id);
      });
      return { output };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Handle workflow.create tool.
   */
  async handleCreateWorkflow(
    args: { schemaId?: string },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    const requestedSchemaId =
      args.schemaId ?? process.env.HARNESS_SCHEMA_ID ?? process.env.HARNESS_PROFILE;
    const schemaFile = requestedSchemaId
      ? requestedSchemaId.endsWith('.yaml')
        ? requestedSchemaId
        : `${requestedSchemaId}.yaml`
      : undefined;

    const profiles = await listProfiles(this.profilesDir);
    const matchingProfiles = schemaFile
      ? profiles.filter((profile) => profile.schemas?.includes(schemaFile))
      : [];
    const resolvedProfileId = matchingProfiles.length === 1 ? matchingProfiles[0]!.id : undefined;

    if (!resolvedProfileId) {
      if (profiles.length === 0) {
        if (process.env.DEBUG_TUI !== '0') {
          const client = this.context.client as unknown as {
            post?: (
              path: string,
              input: { body: { message: string; variant: 'error' } }
            ) => Promise<unknown>;
          };
          void client
            .post?.('/tui/show-toast', {
              body: {
                message: `No workflow profiles found in ${this.profilesDir}. Set STATE_MACHINE_PROFILES_DIR env or create a profile to use workflow tools.`,
                variant: 'error',
              },
            })
            .catch(() => {});
        }
        return {
          output: `No workflow profiles found in ${this.profilesDir}. Set STATE_MACHINE_PROFILES_DIR or create a profile to use workflow tools.`,
        };
      }
      return {
        output: `schemaId is required or unknown. Available schemas: ${profiles
          .flatMap((profile) => profile.schemas ?? [])
          .join(', ')}`,
      };
    }

    // Check if session already exists
    const existing = await this.store.load(ctx.sessionID);
    if (existing) {
      return { output: `Session already exists: ${ctx.sessionID}` };
    }

    try {
      await this.mutationOrchestrator.resolveEngine(resolvedProfileId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix =
        error instanceof ProfileConfigurationError
          ? 'Profile configuration error'
          : 'Profile resolution error';
      return { output: `${prefix}: ${message}` };
    }

    const session = createSession(ctx.sessionID, resolvedProfileId);
    await this.store.save(session);

    void this.log('info', `Workflow session created`, {
      sessionID: session.sessionId,
      profileId: resolvedProfileId,
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

  /**
   * Handle workflow.consent tool.
   *
   * Reads plan files from disk, computes integrity evidence, stores a consent
   * request on the session, and returns a consent tag. The agent then calls
   * question(...) to show the user the approve/decline choice.
   */
  async handleWorkflowConsent(
    args: {
      files: string[];
      summary: string;
      grant?: string;
      decline?: string;
    },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    const session = await this.store.load(ctx.sessionID);
    if (!session) {
      return { output: 'No workflow session found. Call workflow.create first.' };
    }

    // Read and canonicalize each file to compute combined evidence
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
      const absolute = resolve(this.context.directory, file);
      if (!existsSync(absolute)) {
        return { output: `File not found: ${file}` };
      }
      const content = readFileSync(absolute, 'utf-8');
      fileContents.push(canonicalizePlan(content));
    }

    // Compute consent evidence from the primary plan file
    const primaryContent = fileContents[0];
    const consentEvidence = computeSha256(primaryContent);

    // The tag's `revision` attribute and its manifest's `revision` must be the
    // same number — `parseConsentRequest` rejects the tag otherwise. Snapshot it
    // once: the save below advances `session.revision`, and reading it twice
    // produced a tag that could never be parsed.
    const revision = session.revision;

    // Build consent manifest for backward compat
    const manifest: ConsentManifest = {
      schema: 'harness.consent.evidence/v1' as const,
      revision,
      summary: args.summary,
      files: args.files,
    };
    const manifestEvidence = evidenceOf(manifest);

    await this.store.save(session);

    void this.log('info', 'workflow.consent: consent request prepared', {
      sessionID: ctx.sessionID,
      summary: args.summary,
      files: args.files,
      evidence: consentEvidence.slice(0, 16),
    });

    // Return the consent tag so the agent can embed it in a question call.
    // The manifest evidence is embedded so the consent-orchestrator can
    // verify it when the user answers.
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

  /**
   * Handle [chat.message] — run guardrails on user input, capture baseline,
   * then evaluate rules.
   */
  async handleChatMessage(
    input: {
      sessionID: string;
      messageID?: string;
      message?: { role?: string; id?: string };
      parts?: Array<{ type?: string; text?: string; id?: string }>;
    },
    output?: { parts?: Array<Record<string, unknown>>; message?: { id?: string } }
  ): Promise<void> {
    const sessionID = input?.sessionID;
    const session = sessionID ? await this.store.load(sessionID) : null;
    if (!session) {
      void this.log('debug', 'chat.message: no session found', { sessionID });
      return;
    }

    const stage = session.currentStage ?? 'planning';
    const activeGates = session.gates
      .filter((g) => g.status !== 'pending')
      .map((g) => `${g.id}=${g.status}`);
    const grantedApprovals = session.approvals
      .filter((a) => a.status === 'granted')
      .map((a) => a.type);

    void this.log('debug', 'Chat message — workflow state', {
      sessionID,
      stage,
      gates: activeGates.length > 0 ? activeGates.join(',') : undefined,
      approvals: grantedApprovals.length > 0 ? grantedApprovals.join(',') : undefined,
      referenceId: session.refs?.plan ?? undefined,
      taskListsCount: Object.keys(session.tasks).length,
      tasksTotal: Object.values(session.tasks).reduce((sum, list) => sum + list.length, 0),
      tasksCompleted: Object.values(session.tasks).reduce(
        (sum, list) => sum + list.filter((t) => t.status === 'completed').length,
        0
      ),
      revision: session.revision,
    });

    // TODO: guardrails для chat.message будет реализован, когда SDK начнёт
    // передавать текст сообщения. Пока блокировка работает в handleToolBefore.
    void validateUserInput;

    // Delegate to rules sub-system
    await this.rulesRuntime.handleChatMessage(input, output ?? ({} as never));
  }

  /**
   * P1-012: Resolve the pre-commit HEAD sha for delivery permit.
   */
  private getPreCommitHead(): string {
    try {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (result.status === 0) return (result.stdout ?? '').trim();
    } catch {
      void this.log('warn', 'getPreCommitHead: git rev-parse failed', {});
    }
    return 'unknown';
  }

  /**
   * P1-012: Handle tool.execute.before — runs guardrails, consent, or mutation.
   */
  async handleToolBefore(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown }
  ): Promise<void> {
    // 0. Opt-in gate — no workflow session means no plugin mechanics at all.
    if (!(await this.hasWorkflowSession(input.sessionID))) return;

    // Normalize tool name to lowercase (SDK may send any casing)
    const tool = this.normalizeTool(input.tool);

    // SDK передаёт args вызова в output.args для tool.execute.before,
    // НЕ в input.args (в input.args нет поля args по типам SDK).
    const args = output.args;

    // Every refusal below throws WorkflowBlockedError: the host cancels the
    // tool call only when this hook rejects. See blocked-error.ts.

    // 1. Guardrails — always check first
    this.guardrailBefore(args);

    // 1b. Rules — PreToolUse evaluation (throws to block the tool; let it through)
    await this.rulesRuntime.handleToolExecuteBefore(input, output);

    // 2. Consent parsing (Question tool)
    if (await this.consentBefore(tool, input.sessionID, input.callID, args)) return;

    // 3. Task admission — correlate the native call with declarative workflow work.
    // Проверяем только task с маркером [workflow-task:] — обычные task (architect и т.д.) проходят без admission.
    if (this.isWorkflowTask(tool, args)) {
      await this.handleTaskBefore(input.sessionID, input.callID, args, output);
    }

    // 4. Commit Permit: block forbidden git commands, issue deliveryPermit for commit-task
    await this.commitBefore(tool, input.sessionID, input.callID, args, output);

    // 5. Mutation guard (Bash/Write tool)
    await this.mutationBefore(tool, input.sessionID, input.callID, output);
  }

  private isWorkflowTask(tool: string, args: unknown): boolean {
    if (tool !== 'task') return false;
    if (!args || typeof args !== 'object') return false;
    const description = (args as Record<string, unknown>).description;
    return (
      typeof description === 'string' &&
      /^\[workflow-task:(task-[0-9]+)\](?:\s|$)/.test(description)
    );
  }

  private async handleTaskBefore(
    sessionID: string,
    callID: string,
    args: unknown,
    output: { args: unknown }
  ): Promise<void> {
    const taskArgs = args as Record<string, unknown>;
    const agent = (taskArgs.subagent_type ?? taskArgs.agent ?? taskArgs.type) as string;
    const description = taskArgs.description;
    const match =
      typeof description === 'string'
        ? /^\[workflow-task:(task-[0-9]+)\](?:\s|$)/.exec(description)
        : null;

    // match гарантированно не null — проверка уже в isWorkflowTask
    const taskId = match![1];

    await this.queue.enqueue(sessionID, async (session) => {
      if (!session) return;
      if (session.activeOperations[callID]) {
        this.blockTaskAdmission(`Native call ${callID} is already correlated`);
        return;
      }

      let profile;
      let engine;
      try {
        const profileRoot = getProfilesDir(this.context.directory);
        profile = await resolveConfig(session.profileId, profileRoot);
        engine = await this.mutationOrchestrator.resolveEngine(session.profileId);
      } catch (error) {
        this.blockTaskAdmission(
          `Cannot resolve workflow admission profile: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }

      const loopStageId = engine.deriveStage(session);
      session.currentStage = loopStageId;
      const loopStage = engine.getStages()[loopStageId];
      if (!loopStage?.loop || nestedStages(loopStage).length === 0) {
        this.blockTaskAdmission(`Stage ${loopStageId} does not declare an executable task loop`);
        return;
      }
      // A loop that names no dispatch runs one task at a time. Requiring the
      // field made every profile repeat boilerplate, and forgetting it stopped
      // the loop with a message about a loop that is plainly declared.
      const dispatch = loopStage.dispatch ?? { strategy: 'serial' as const, maxConcurrent: 1 };

      const listKey = this.resolveAdmissionListKey(session, loopStage.loop, taskId);
      const tasks = listKey ? session.tasks[listKey] : undefined;
      const task = tasks?.find((candidate) => candidate.id === taskId);
      if (!listKey || !tasks || !task) {
        this.blockTaskAdmission(
          `Workflow task ${taskId} is not eligible in loopStage ${loopStageId}`
        );
        return;
      }

      const nonterminalRuns = Object.values(session.loopRuns).filter(
        (run) => run.taskId === taskId && isOpenLoopRun(run)
      );
      if (nonterminalRuns.length > 1) {
        this.blockTaskAdmission(`Workflow task ${taskId} has ambiguous active loop runs`);
        return;
      }
      const existingRun = nonterminalRuns[0];
      if (existingRun?.status === 'awaiting_decision') {
        this.blockTaskAdmission(`Workflow task ${taskId} is awaiting a retry decision`);
        return;
      }
      if (!existingRun && task.status !== 'pending') {
        this.blockTaskAdmission(`Workflow task ${taskId} is not pending`);
        return;
      }

      const stageId = existingRun?.stage ?? firstNestedStageId(loopStage)!;
      const stage = nestedStages(loopStage).find((candidate) => candidate.id === stageId);
      if (!stage) {
        this.blockTaskAdmission(`Stage ${stageId} is not declared by stage ${loopStageId}`);
        return;
      }
      // A nested stage may narrow its parent's roster; when it declares none,
      // the parent's list applies. This is the only place agent identity is
      // known, so it is the only place `allowedAgents` can be enforced.
      const allowedAgents = stage.allowedAgents ?? loopStage.allowedAgents;
      if (allowedAgents?.length && !agentIsAllowed(agent, allowedAgents, session.profileId)) {
        this.blockTaskAdmission(
          `Agent ${agent} is not allowed in stage ${stageId}. Allowed: ${allowedAgents.join(', ')}`
        );
        return;
      }
      // A stage that declares gates is waiting for several verdicts, so it may
      // have one call per gate at a time — review and qa run together. Every
      // other stage is one call at a time, and the same agent may never hold
      // two: one agent cannot judge the same work twice at once.
      const running = Object.values(session.activeOperations).filter(
        (operation) => operation.taskId === taskId && operation.status === 'running'
      );
      const gateCount = stage.gates?.length ?? 0;
      if (running.length > 0) {
        const sameAgent = running.some((operation) => operation.agent === agent);
        if (gateCount === 0) {
          this.blockTaskAdmission(`Workflow task ${taskId} already has an active call`);
          return;
        }
        if (sameAgent) {
          this.blockTaskAdmission(
            `Agent ${agent} already has an active call for workflow task ${taskId}`
          );
          return;
        }
        if (running.length >= gateCount) {
          this.blockTaskAdmission(
            `Stage ${stageId} is waiting on ${gateCount} verdict(s) and already has that many calls`
          );
          return;
        }
      }

      if (
        stage.entryGuards?.some(
          (guard) => !engine.evaluateGuard(guard, session, { currentLoopListKey: listKey })
        )
      ) {
        this.blockTaskAdmission(`Entry guard rejected stage ${stageId}`);
        return;
      }

      const activeRuns = Object.values(session.loopRuns).filter((run) => isOpenLoopRun(run));
      if (!existingRun) {
        const rejection = this.taskAdmissionRejection(
          dispatch,
          tasks,
          taskId,
          activeRuns,
          firstNestedStageId(loopStage)!
        );
        if (rejection) {
          this.blockTaskAdmission(rejection);
          return;
        }
      }

      const runId = existingRun?.id ?? nextLoopRunId(session);
      if (!existingRun) {
        session.loopRuns[runId] = {
          id: runId,
          taskId,
          listKey,
          ancestry: this.resolveTaskAncestry(session.tasks, listKey),
          stage: stageId,
          status: 'running',
          gates: {},
          round: 0,
        };
        task.status = 'running';
      }
      session.activeOperations[callID] = {
        callId: callID,
        runId,
        taskId,
        agent,
        status: 'running',
        startedAt: new Date().toISOString(),
        // The occupancy of the stage this call belongs to. A verdict that
        // arrives after the task has moved on belongs to a round that is over.
        round: session.loopRuns[runId]?.round ?? 0,
      };

      upsertActiveTaskContext(session, {
        runId,
        taskId,
        agent,
        callId: callID,
        status: 'running',
      });

      void this.log('info', 'Workflow task admitted', {
        sessionID,
        callID,
        runId,
        taskId,
        agent,
        stage: stageId,
        displayDescription:
          typeof description === 'string' ? description.slice(match[0].length).trimStart() : '',
      });
    });
  }

  private blockTaskAdmission(reason: string): never {
    throw new WorkflowBlockedError(reason);
  }

  private resolveAdmissionListKey(
    session: WorkflowSession,
    loop: string,
    taskId: string
  ): string | null {
    if (loop !== '$currentTask.id') {
      return session.tasks[loop]?.some((task) => task.id === taskId) ? loop : null;
    }
    const matches = Object.entries(session.tasks)
      .filter(
        ([listKey, tasks]) =>
          /^task-[0-9]+$/.test(listKey) && tasks.some((task) => task.id === taskId)
      )
      .map(([listKey]) => listKey);
    return matches.length === 1 ? matches[0] : null;
  }

  private taskAdmissionRejection(
    dispatch: NonNullable<StageDef['dispatch']>,
    tasks: MutationTask[],
    taskId: string,
    activeRuns: LoopRun[],
    firstStageId: string
  ): string | null {
    if (dispatch.strategy !== 'serial' && activeRuns.length >= dispatch.maxConcurrent) {
      return `Task cycle concurrency limit ${dispatch.maxConcurrent} is exhausted`;
    }

    const taskIndex = tasks.findIndex((task) => task.id === taskId);
    const firstUnfinishedIndex = tasks.findIndex(
      (task) => task.status === 'pending' || task.status === 'running'
    );
    if (dispatch.strategy === 'serial') {
      if (taskIndex !== firstUnfinishedIndex || activeRuns.length > 0) {
        return `Serial task cycle admits only the next unfinished task`;
      }
      return null;
    }
    if (dispatch.strategy === 'parallel') return null;

    if (taskIndex === 0) return activeRuns.length === 0 ? null : 'First task is already active';
    const priorTask = tasks[taskIndex - 1];
    const priorRun = activeRuns.find((run) => run.taskId === priorTask.id);
    const priorIsTerminal = ['completed', 'failed', 'cancelled'].includes(priorTask.status);
    if (!priorIsTerminal && (!priorRun || priorRun.stage === firstStageId)) {
      return `Overlapping task cycle waits for ${priorTask.id} to leave ${firstStageId}`;
    }
    const earlierTaskStillPending = tasks
      .slice(0, taskIndex - 1)
      .some((task) => task.status === 'pending');
    return earlierTaskStillPending ? 'Overlapping task cycle must preserve task order' : null;
  }

  private hasRunningOperationForTask(session: WorkflowSession, taskId: string): boolean {
    return Object.values(session.activeOperations).some(
      (operation) => operation.taskId === taskId && operation.status === 'running'
    );
  }

  private resolveTaskAncestry(
    tasks: Record<string, Array<{ id?: string }>>,
    listKey: string
  ): Array<{ listKey: string; taskId: string }> {
    const ancestry: Array<{ listKey: string; taskId: string }> = [];
    let childListKey = listKey;
    const visited = new Set<string>();
    while (/^task-[0-9]+$/.test(childListKey) && !visited.has(childListKey)) {
      visited.add(childListKey);
      const parent = Object.entries(tasks).find(([, tasks]) =>
        tasks.some((task) => task.id === childListKey)
      );
      if (!parent) break;
      ancestry.unshift({ listKey: parent[0], taskId: childListKey });
      childListKey = parent[0];
    }
    return ancestry;
  }

  /**
   * P1-012: Handle commit-task command — check canCommit, issue deliveryPermit.
   */
  private async handleCommitTaskBefore(
    sessionID: string,
    callID: string,
    output: { args: unknown }
  ): Promise<void> {
    const session = await this.store.load(sessionID);
    // No workflow session means the plugin does not apply — skip silently
    // rather than blocking a call it does not govern.
    if (!session) return;

    const engine = await this.mutationOrchestrator.resolveEngine(session.profileId);
    const requiredGates = engine.getRequiredGates();
    if (!canCommit(session, requiredGates)) {
      throw new WorkflowBlockedError('Cannot commit: not all gates passed or tasks completed');
    }

    const preCommitHead = this.getPreCommitHead();
    session.deliveryPermit = {
      callID,
      preCommitHead,
      expectedFiles: [...session.changedFiles],
      startedAt: new Date().toISOString(),
    };
    await this.store.save(session);
    void this.log('info', `Issued deliveryPermit for commit`, { callID, preCommitHead, sessionID });
  }

  /**
   * Handle tool.execute.after — runs guardrails, consent, or mutation.
   */
  async handleToolAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    // 0. Opt-in gate — no workflow session means no plugin mechanics at all.
    if (!(await this.hasWorkflowSession(input.sessionID))) return;

    // Normalize tool name to lowercase (SDK may send any casing)
    const tool = this.normalizeTool(input.tool);

    // 1. Guardrails — always sanitize output
    output.output = this.guardrailAfter(output.output, tool);

    // 1b. Workflow result — parse and record <workflow-result> tags
    await this.handleWorkflowResult(tool, input.sessionID, input.callID, input.args, output);

    // 1c. Rules — PostToolUse evaluation + file observations
    await this.rulesRuntime.handleToolExecuteAfter(input, output);

    // 1d. File tool — run invariants on written/edited files
    await this.handleFileToolAfter(tool, input, output);

    // 2. Commit Permit: verify HEAD changed after commit-task
    if (tool === 'bash') {
      await this.handleCommitTaskAfter(input.sessionID, input.callID, output);
    }

    // 3. Question tool — consent request (approve/decline plan)
    if (tool === 'question') {
      await this.consentAfter(tool, input.sessionID, input.callID, input.args, output);
    }

    // 5. Finish mutation (Bash/Write tool) — единственный путь finalization.
    //    MutationOrchestrator.finishMutation вычисляет scope, валидацию
    //    инвариантов и устанавливает gate через один вызов domain finishMutation.
    await this.mutationAfter(tool, input.sessionID, input.callID, output);

    // 6. Try transitions — после любого инструмента проверяем, можно ли перейти
    await this.transitionAfter(input.sessionID);
  }

  /**
   * P1-012: After commit-task runs, verify HEAD changed and record deliveryReceipt.
   *
   * The receipt is the only thing that releases `commit -> done`, so it is
   * written only against evidence: HEAD moved AND the commit contains exactly
   * the files the permit expected. Anything else — a commit of unrelated
   * files, a partial commit, or a file list we cannot read — leaves the
   * session without a receipt and drops the permit, so the workflow stays in
   * `commit` and the agent must re-run the step under a fresh permit.
   */
  private async handleCommitTaskAfter(
    sessionID: string,
    callID: string,
    output: { output: string }
  ): Promise<void> {
    const session = await this.store.load(sessionID);
    if (!session) return;
    if (!session.deliveryPermit) return;
    if (session.deliveryPermit.callID !== callID) return;

    const currentHead = this.getPreCommitHead();
    if (currentHead === session.deliveryPermit.preCommitHead || currentHead === 'unknown') {
      // HEAD не изменился — коммит не создан
      return;
    }

    // Получаем список закоммиченных файлов. Пустой или нечитаемый список —
    // это отсутствие доказательства, а не разрешение.
    let committed: string[] | null = null;
    try {
      const result = spawnSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', currentHead],
        {
          cwd: this.projectDir,
          encoding: 'utf-8',
          timeout: 5000,
        }
      );
      if (result.status === 0) {
        committed = (result.stdout ?? '').split('\n').filter(Boolean).sort();
      }
    } catch {
      void this.log('warn', 'handleCommitTaskAfter: git diff-tree failed', { sessionID });
    }

    const expected = [...(session.deliveryPermit.expectedFiles ?? [])].sort();
    const reject = (reason: string, extra: Record<string, unknown>): void => {
      session.deliveryPermit = null;
      output.output += `\n\n[workflow-commit-rejected]\n${reason}\nThe commit ${currentHead} stands in git, but no delivery receipt was recorded: the workflow stays in \`commit\`. Reconcile the worktree and run the commit step again.`;
      void this.log('warn', `handleCommitTaskAfter: ${reason}`, { sessionID, callID, ...extra });
    };

    if (committed === null || committed.length === 0) {
      reject(
        'Could not determine which files commit ' +
          currentHead +
          ' contains, so the commit cannot be verified against the permit.',
        { expected }
      );
      await this.store.save(session);
      return;
    }

    if (JSON.stringify(committed) !== JSON.stringify(expected)) {
      reject(
        `Committed files do not match the delivery permit.\nExpected: ${expected.join(', ') || '(none)'}\nCommitted: ${committed.join(', ')}`,
        { expected, committed }
      );
      await this.store.save(session);
      return;
    }

    session.deliveryReceipt = currentHead;
    session.deliveryPermit = null;
    await this.store.save(session);
    void this.log('info', `Commit detected: ${currentHead}`, {
      sessionID,
      callID,
      fileCount: committed.length,
    });
  }

  /**
   * SDK-005: Inject workflow session context into the system prompt.
   * Called before each model request — adds stage, gates, and approvals
   * so the model is aware of the current workflow state.
   */
  async handleSystemTransform(
    input: { sessionID?: string; model: unknown },
    output: { system: string[] }
  ): Promise<void> {
    if (!input.sessionID) return;

    const session = await this.store.load(input.sessionID);
    if (!session) return;

    const lines = [...output.system];
    lines.push(`[workflow session: ${session.sessionId}]`);
    lines.push(`[workflow profile: ${session.profileId}]`);

    // Read stage directly from session — currentStage is set by tryApplyTransitions.
    // Falls back to 'planning' if not yet set (new sessions).
    const stage = session.currentStage ?? 'planning';
    lines.push(`[workflow stage: ${stage}]`);

    const gateLines = session.gates
      .filter((g) => g.status !== 'pending')
      .map((g) => `${g.id}=${g.status}`);
    if (gateLines.length > 0) {
      lines.push(`[workflow gates: ${gateLines.join(', ')}]`);
    }

    const approvalTypes = session.approvals
      .filter((a) => a.status === 'granted')
      .map((a) => a.type);
    if (approvalTypes.length > 0) {
      lines.push(`[workflow approvals: ${approvalTypes.join(', ')}]`);
    }

    const activeOperations = Object.values(session.activeOperations);
    if (activeOperations.length > 0) {
      lines.push(`[workflow active operations: ${activeOperations.length}]`);
    }

    const pendingDecisions = (session.pendingDecisions ?? []).filter(
      (decision) => decision.status === 'pending'
    );
    for (const decision of pendingDecisions) {
      lines.push(
        `[workflow pending decision: ${decision.subject} ${decision.subjectId} ${decision.kind}; use workflow.tasks-resolve-decision (no taskId needed)]`
      );
    }

    const tasks = Object.values(session.tasks).flat();
    lines.push(`[workflow tasks: ${tasks.length} total, revision ${session.revision}]`);

    output.system = lines;
  }

  /**
   * Handle session compaction — augment existing context with rules sub-system output.
   */
  async handleSessionCompacting(
    input: { sessionID?: string },
    output: { context: string[]; prompt?: string }
  ): Promise<void> {
    // Opt-in gate — no workflow session means no plugin mechanics at all.
    if (!(await this.hasWorkflowSession(input.sessionID))) return;

    const rulesOutput = { context: [...output.context], prompt: undefined as string | undefined };
    await this.rulesRuntime.handleSessionCompacting(input, rulesOutput);
    output.context = rulesOutput.context;
    if (rulesOutput.prompt) output.prompt = rulesOutput.prompt;
  }

  /**
   * Handle experimental.chat.messages.transform — delegate to rules sub-system.
   */
  async handleMessagesTransform(
    _input: Record<string, never>,
    output: { messages?: unknown[] }
  ): Promise<void> {
    await this.rulesRuntime.handleMessagesTransform(_input, output as never);
  }

  /**
   * Handle events — clear only errored callId from the mutation orchestrator's
   * in-flight mutation tracking.
   */
  async handleEvent(event: EventEnvelope & {
    event: { properties?: Record<string, unknown> & { part?: EventPart } };
  }): Promise<void> {
    // Check if event indicates an error
    const isError = this.isErrorEvent(event);

    if (isError) {
      // Find the matching callId. The owning session is unknown here, so
      // markTaskOperationInterrupted resolves it by scanning stored sessions —
      // it can only ever touch a session that already exists, which satisfies
      // the opt-in rule without an explicit gate.
      const callId = this.extractCallId(event);
      if (callId) {
        await this.mutationOrchestrator.clearOnError(callId);
        await this.markTaskOperationInterrupted(callId);
      }
    }

    // Rules are a per-session mechanic. The rules sub-system reads the session
    // from `event.properties.sessionID` (not from `part`), so gate on that same
    // field: no workflow session, no rules.
    const rulesSessionID = event.event.properties?.['sessionID'];
    if (
      typeof rulesSessionID === 'string' &&
      (await this.hasWorkflowSession(rulesSessionID))
    ) {
      await this.rulesRuntime.handleEvent(event);
    }
  }

  private async markTaskOperationInterrupted(callId: string): Promise<void> {
    const sessionIds = await this.store.list();
    for (const sessionID of sessionIds) {
      const loaded = await this.store.load(sessionID);
      const loadedOperation = loaded?.activeOperations[callId];
      if (!loadedOperation || loadedOperation.status !== 'running') continue;
      await this.queue.enqueue(sessionID, async (session) => {
        const operation = session?.activeOperations[callId];
        if (!operation || operation.status !== 'running') return;
        operation.status = 'interrupted';
        operation.interruptedAt = new Date().toISOString();
      });
    }
  }

  /**
   * The tool part an event carries, whatever shape the host used.
   *
   * OpenCode emits `message.part.updated` with the part under
   * `properties.part` (`cli/cmd/run.ts` reads it there, and so does its own
   * demo feed). Reading `event.part` found nothing, so a tool that errored
   * left its operation running for ever.
   */
  private eventPart(event: EventEnvelope): EventPart | undefined {
    return event.event.properties?.part ?? event.event.part;
  }

  private isErrorEvent(event: EventEnvelope): boolean {
    if (event.event.type !== 'message.part.updated') return false;
    const part = this.eventPart(event);
    if (!part) return false;
    // A ToolPart carries its status under `state.status`, and the failure
    // value is 'error'. The flat `status: 'failed'` shape is kept for hosts
    // that emit the legacy payload.
    return part.state?.status === 'error' || part.status === 'failed';
  }

  private extractCallId(event: EventEnvelope): string | null {
    const part = this.eventPart(event);
    // `callID` is the correlation identifier; `id` is the fallback for hosts
    // that do not send one.
    return part?.callID ?? part?.id ?? null;
  }

  /**
   * Record a `<workflow-result>` — but only from a verifier that was actually
   * dispatched to produce one.
   *
   * The marker is plain text, so it can appear in anything a tool returns: a
   * file that documents the format, a grep hit, a log. Reading such a file
   * must not close a gate. A verdict counts only when it comes back from a
   * `task` call — the one place the host tells us which agent ran — and, for a
   * stage that declares gates, only when that agent is one the stage allows.
   */
  /** The subagent a `task` call dispatched, as the host reports it. */
  private dispatchedAgent(args: unknown): string | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const value = (args as Record<string, unknown>).subagent_type;
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /**
   * Whether an agent's verdict counts for a stage.
   *
   * A stage that names a roster is naming who may judge it. A stage that names
   * none accepts any dispatched agent — but never a caller the host did not
   * name, because an unnamed judge is not a judge.
   */
  private mayVerify(
    agent: string | undefined,
    stage: { allowedAgents?: string[] } | undefined,
    profileId: string
  ): boolean {
    if (!agent) return false;
    const roster = stage?.allowedAgents ?? [];
    if (roster.length === 0) return true;
    return agentIsAllowed(agent, roster, profileId);
  }

  private async handleWorkflowResult(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { output: string }
  ): Promise<void> {
    if (tool !== 'task') return;
    const parsed = parseWorkflowResult(output.output);
    const reportingAgent = this.dispatchedAgent(args);

    await this.queue.enqueue(sessionID, async (session) => {
      if (!session) return;

      const operation = session.activeOperations[callID];
      const run = operation ? session.loopRuns[operation.runId] : undefined;
      const task = operation ? findTask(session, operation.taskId) : undefined;

      if (
        operation &&
        run &&
        task &&
        operation.status === 'running' &&
        operation.round !== run.round
      ) {
        // The task has entered the stage again — or a different one — since
        // this verifier was dispatched. Its verdict is about work that has
        // already been judged, so NOTHING it says is recorded: not the gate,
        // not the verification. This check has to come before every write,
        // because a stale gate left behind lets a finished round vouch for
        // the round that replaced it, and the stage closes with one verifier
        // of the current round never heard from.
        output.output +=
          `\n\n[workflow-result-stale]\n` +
          `This result was produced for an earlier round of ${task.id}, ` +
          `which has since moved to ${run.stage}. Nothing was recorded.`;
        void this.log('warn', 'Workflow result from a finished round', {
          sessionID,
          taskId: task.id,
          resultRound: operation.round,
          currentRound: run.round,
        });
        delete session.activeOperations[callID];
        return;
      }

      if (parsed) {
        session.verifications.push({
          stage: parsed.stage,
          status: parsed.status === 'pass' ? 'confirmed' : 'rejected',
          recordedAt: new Date().toISOString(),
        });
      }

      if (operation) {
        if (run && task) {
          if (operation.status !== 'running') {
            return;
          }
          const loopStage = parsed
            ? await this.resolveLoopStage(session.profileId, run.listKey)
            : null;
          const nested = loopStage ? nestedStages(loopStage) : [];
          const currentStage = nested.find((entry) => entry.id === run.stage);
          const declaredGates = currentStage?.gates ?? [];

          if (parsed && declaredGates.length > 0) {
            // A verifier stage may run several agents at once — review and qa
            // in parallel — so a tag names the gate it closes, never the stage
            // it ran in. A name the stage does not declare is refused: it is
            // evidence for something nobody asked about.
            if (!this.mayVerify(reportingAgent, currentStage, session.profileId)) {
              output.output +=
                `\n\n[workflow-result-rejected]\n` +
                `Stage ${run.stage} accepts results from ` +
                `[${(currentStage?.allowedAgents ?? []).join(', ') || '(no roster)'}], ` +
                `and this one came from '${reportingAgent ?? '(unknown agent)'}'. ` +
                `Nothing was recorded.`;
              void this.log('warn', 'Workflow result from an agent the stage does not allow', {
                sessionID,
                stage: run.stage,
                agent: reportingAgent ?? null,
              });
              delete session.activeOperations[callID];
              return;
            }
            if (!declaredGates.includes(parsed.stage)) {
              output.output +=
                `\n\n[workflow-result-rejected]\n` +
                `Stage ${run.stage} is waiting on [${declaredGates.join(', ')}], ` +
                `and this result reports '${parsed.stage}'. Nothing was recorded.`;
              void this.log('warn', 'Workflow result names an undeclared gate', {
                sessionID,
                stage: run.stage,
                reported: parsed.stage,
                declared: declaredGates,
              });
              delete session.activeOperations[callID];
              return;
            }
            run.gates[parsed.stage] = parsed.status === 'pass' ? 'passed' : 'failed';
          }

          const stageFailed = declaredGates.some((gate) => run.gates[gate] === 'failed');
          const stagePassed =
            declaredGates.length > 0 && declaredGates.every((gate) => run.gates[gate] === 'passed');
          // A stage with no gates keeps the old contract: its single agent's
          // own pass or fail decides.
          const failed = declaredGates.length > 0 ? stageFailed : parsed?.status === 'fail';
          const passed = declaredGates.length > 0 ? stagePassed : parsed?.status === 'pass';

          if (!parsed) {
            // A workflow task that reports nothing is not a task that passed.
            // Saying so is the difference between a stalled loop and a stalled
            // loop nobody can explain.
            output.output +=
              `\n\n[workflow-result-missing]\n` +
              `Stage ${run.stage} of ${task.id} ended without a <workflow-result> marker, ` +
              `so nothing was recorded and the task did not move.`;
            void this.log('warn', 'Workflow task returned no result', {
              sessionID,
              taskId: task.id,
              stage: run.stage,
              outputPreview: output.output.slice(0, 200),
            });
          }

          if (failed || passed) {
            const engine = await this.mutationOrchestrator.resolveEngine(session.profileId);
            const movement = nextTaskStage(
              loopStage,
              run,
              passed,
              (expression, facts) =>
                engine.evaluateGuard(expression, toGuardContext(session, { ...facts }), {
                  currentLoopListKey: run.listKey,
                }),
              (type) =>
                session.approvals.some(
                  (approval) => approval.type === type && approval.status === 'granted'
                )
            );

            // An edge that is taken applies what it declares, at either level
            // and whichever way it ends. The retry budget below is the one
            // effect with its own conditions; everything else follows the
            // edge, because a schema that is accepted has to be obeyed.
            if (movement.kind === 'complete' || movement.kind === 'move') {
              this.applyApprovalEffects(
                session,
                run,
                movement.kind === 'move' ? movement.to : TASK_DONE,
                movement.effects
              );
            }

            if (movement.kind === 'complete') {
              run.status = 'completed';
              task.status = 'completed';
              removeActiveTaskContext(session, run.id);
            } else if (movement.kind === 'move') {
              // A move that walks a failure back into the loop spends the
              // task's budget whether or not the edge remembered to say so.
              // An edge without the effect would otherwise cycle forever, and
              // the operator would never be asked.
              const spendsBudget =
                failed || (movement.effects ?? []).some((e) => e.bumpRetry !== undefined);
              const exhausted = spendsBudget
                ? this.applyTaskEffects(session, run, task, loopStage, movement.effects, failed)
                : false;
              run.stage = movement.to;
              // Each stage judges its own work: the next one starts with no
              // verdicts carried over from the last, and a new round, so any
              // verifier still working the previous one is answered too late.
              run.gates = {};
              run.round += 1;
              if (exhausted) {
                run.status = 'awaiting_decision';
                this.upsertActiveTaskContextFromSession(session, run.id, 'awaiting_decision');
                this.upsertPendingDecision(session, task.id, run.id);
              } else {
                task.status = 'running';
                run.status = 'running';
                this.upsertActiveTaskContextFromSession(session, run.id, 'running');
              }
            } else if (failed) {
              // No transition took the failure, so the loop's own retry budget
              // decides: back to the first stage, or a decision for the operator.
              this.recordTaskRetryFailure(session, run, task, loopStage);
            }
          }
        }
        delete session.activeOperations[callID];
      } else if (parsed) {
        // A verdict about the whole body of work, not about one task: the
        // current stage's own gates. A stage is a stage at either level, so the
        // rule is the same — the tag names a gate the stage declared, or it is
        // refused.
        await this.recordStageGate(session, parsed, reportingAgent, output);
        delete session.activeOperations[callID];
      }

      if (parsed) {
        void this.log('info', `Workflow result recorded`, {
          sessionID,
          stage: parsed.stage,
          status: parsed.status,
          summary: parsed.summary,
        });
      }
    });
  }

  /**
   * Close a gate on the session's current stage from a `<workflow-result>`.
   *
   * The loop case records a verdict about one task; this records one about the
   * work as a whole — the `validation` stage of the shipped workflow, where the
   * same review and qa agents check everything that was built.
   */
  private async recordStageGate(
    session: WorkflowSession,
    parsed: { stage: string; status: 'pass' | 'fail' },
    reportingAgent: string | undefined,
    output: { output: string }
  ): Promise<void> {
    const stageId = session.currentStage;
    if (!stageId) return;

    let stage: StageDef | undefined;
    try {
      const engine = await this.mutationOrchestrator.resolveEngine(session.profileId);
      stage = engine.getStages()[stageId];
    } catch (error) {
      // A profile we cannot read declares no gates we can honour. The verdict
      // is still recorded in `verifications`; nothing is invented here.
      void this.log('warn', 'recordStageGate: profile could not be resolved', {
        sessionID: session.sessionId,
        profileId: session.profileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const declaredGates = stage?.gates ?? [];
    if (declaredGates.length === 0) return;

    if (!this.mayVerify(reportingAgent, stage, session.profileId)) {
      output.output +=
        `\n\n[workflow-result-rejected]\n` +
        `Stage ${stageId} accepts results from ` +
        `[${(stage?.allowedAgents ?? []).join(', ') || '(no roster)'}], and this one came from ` +
        `'${reportingAgent ?? '(unknown agent)'}'. Nothing was recorded.`;
      void this.log('warn', 'Workflow result from an agent the stage does not allow', {
        sessionID: session.sessionId,
        stage: stageId,
        agent: reportingAgent ?? null,
      });
      return;
    }

    if (!declaredGates.includes(parsed.stage)) {
      output.output +=
        `\n\n[workflow-result-rejected]\n` +
        `Stage ${stageId} is waiting on [${declaredGates.join(', ')}], ` +
        `and this result reports '${parsed.stage}'. Nothing was recorded.`;
      void this.log('warn', 'Workflow result names an undeclared gate', {
        sessionID: session.sessionId,
        stage: stageId,
        reported: parsed.stage,
        declared: declaredGates,
      });
      return;
    }

    setGateStatus(session, parsed.stage, parsed.status === 'pass' ? 'passed' : 'failed');
    void this.log('info', 'Stage gate recorded', {
      sessionID: session.sessionId,
      stage: stageId,
      gate: parsed.stage,
      status: parsed.status,
    });
  }

  /**
   * The stage that cycles over a task list.
   *
   * Resolved through the engine, which holds the merged stage map: a profile
   * resolves to several schema files, and searching them one by one returns
   * whichever the search order reaches first — a parent's guard from one file,
   * a child's roster from another, never the stage the workflow actually runs.
   */
  private async resolveLoopStage(profileId: string, listKey: string): Promise<StageDef | null> {
    const engine = await this.mutationOrchestrator.resolveEngine(profileId);
    return engine.getLoopStage(listKey);
  }

  /**
   * Apply a task-scoped transition's effects. Returns true when a retry budget
   * was spent to its limit, which is the operator's decision to make.
   *
   * `bumpRetry` inside a loop always means the task's own budget, and must be
   * written as `task.id`: a budget key naming something else would silently
   * spend a counter nobody is watching.
   */
  /**
   * Apply the effects of a taken edge that are not the retry budget.
   *
   * The budget has its own conditions — a failure spends it whether the edge
   * says so or not — but everything else on the edge is unconditional: the
   * schema declared it, the edge was taken, so it happens. An approval granted
   * here is what a later `consent:` on the same loop is waiting for.
   */
  private applyApprovalEffects(
    session: WorkflowSession,
    run: LoopRun,
    to: string,
    effects: TransitionDef['effects']
  ): void {
    for (const effect of effects ?? []) {
      if (!effect.approve) continue;
      approve(session, effect.approve, '', `transition:${run.stage}->${to}`);
      void this.log('info', 'Task transition granted an approval', {
        sessionID: session.sessionId,
        taskId: run.taskId,
        approval: effect.approve,
        from: run.stage,
        to,
      });
    }
  }

  private applyTaskEffects(
    session: WorkflowSession,
    run: LoopRun,
    task: MutationTask,
    loopStage: StageDef | null,
    effects: TransitionDef['effects'],
    spendOnFailure = false
  ): boolean {
    let exhausted = false;
    const declared = (effects ?? []).filter((effect) => effect.bumpRetry !== undefined);

    // A failing stage always costs the task an attempt. Writing
    // `effects: [{ bumpRetry: task.id }]` on the edge documents it and can set
    // a different maximum; leaving it off does not buy an unbounded loop.
    if (declared.length === 0 && spendOnFailure) {
      return this.spendTaskAttempt(session, task, loopStage, undefined);
    }

    for (const effect of declared) {
      if (effect.bumpRetry === undefined) continue;
      if (effect.bumpRetry !== 'task.id') {
        void this.log('warn', 'Task transition bumps a budget that is not the task', {
          sessionID: session.sessionId,
          stage: run.stage,
          declared: effect.bumpRetry,
        });
        continue;
      }
      if (this.spendTaskAttempt(session, task, loopStage, effect.maxAttempts)) exhausted = true;
    }
    return exhausted;
  }

  /** Spend one attempt of a task's retry budget. True when it is now spent. */
  private spendTaskAttempt(
    session: WorkflowSession,
    task: MutationTask,
    loopStage: StageDef | null,
    maxAttempts: number | undefined
  ): boolean {
    const budget = session.retryBudgets[task.id] ?? {
      attempts: 0,
      maximum: maxAttempts ?? loopStage?.retryBudget?.maximum ?? DEFAULT_TASK_RETRY_MAXIMUM,
    };
    if (maxAttempts !== undefined) budget.maximum = maxAttempts;
    budget.attempts += 1;
    session.retryBudgets[task.id] = budget;
    return budget.attempts >= budget.maximum;
  }

  private recordTaskRetryFailure(
    session: WorkflowSession,
    run: LoopRun,
    task: MutationTask,
    stage: StageDef | null
  ): void {
    const existingBudget = session.retryBudgets[task.id];
    const budget = existingBudget ?? {
      attempts: 0,
      maximum: stage?.retryBudget?.maximum ?? DEFAULT_TASK_RETRY_MAXIMUM,
    };
    budget.attempts += 1;
    session.retryBudgets[task.id] = budget;
    task.status = 'running';
    run.stage = firstNestedStageId(stage) ?? run.stage;
    // The same rule as a transition-driven move: a stage starts with no
    // verdicts carried over, and a new round. A task sent back to the beginning
    // holding the failure that sent it there would be judged on work it has not
    // redone, and a verifier still working the old round would spend its budget
    // a second time.
    run.gates = {};
    run.round += 1;

    if (budget.attempts < budget.maximum) {
      run.status = 'running';
      this.upsertActiveTaskContextFromSession(session, run.id, 'running');
      return;
    }

    run.status = 'awaiting_decision';
    this.upsertActiveTaskContextFromSession(session, run.id, 'awaiting_decision');
    this.upsertPendingDecision(session, task.id, run.id);
  }

  private upsertPendingDecision(session: WorkflowSession, taskId: string, runId: string): void {
    const pendingDecisions = (session.pendingDecisions ??= []);
    const existing = pendingDecisions.find(
      (decision) =>
        decision.subject === 'task' &&
        decision.subjectId === taskId &&
        decision.kind === RETRY_EXHAUSTED_DECISION_KIND &&
        decision.status === 'pending'
    );
    if (existing) {
      if (!existing.runId) existing.runId = runId;
      return;
    }
    pendingDecisions.push({
      id: `${taskId}:${RETRY_EXHAUSTED_DECISION_KIND}`,
      subject: 'task',
      subjectId: taskId,
      runId,
      kind: RETRY_EXHAUSTED_DECISION_KIND,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  private clearPendingDecision(session: WorkflowSession, decisionId: string): void {
    session.pendingDecisions = (session.pendingDecisions ?? []).filter(
      (decision) => decision.id !== decisionId
    );
  }

  private upsertActiveTaskContextFromSession(
    session: WorkflowSession,
    runId: string,
    status: 'running' | 'awaiting_decision'
  ): void {
    const existing = session.activeTaskContexts.find((a) => a.runId === runId);
    const agent = existing?.agent ?? '';
    upsertActiveTaskContext(session, { runId, taskId: existing?.taskId ?? '', agent, status });
  }

  /**
   * Handle file tool after — run invariants on written/edited files.
   */
  private async handleFileToolAfter(
    tool: string,
    input: {
      tool: string;
      sessionID: string;
      callID: string;
      args?: { filePath?: string; path?: string; file?: string };
    },
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    if (!this.fileTools.has(tool)) return;

    const candidate = input.args?.filePath ?? input.args?.path ?? input.args?.file;
    if (typeof candidate !== 'string') return;

    const absolute = resolve(this.context.directory, candidate);
    const local = relative(this.context.directory, absolute);

    // Проверяем, что файл внутри проекта и имеет поддерживаемое расширение
    if (isAbsolute(local) || local.startsWith('..') || !SUPPORTED_EXTENSIONS.test(local)) return;

    // Проверяем существование файла
    if (!existsSync(absolute)) return;

    // Загружаем профиль сессии и запускаем инварианты
    try {
      const session = await this.store.load(input.sessionID);
      if (!session) return;

      const profilesDir = getProfilesDir(this.context.directory);
      const result = await validateFilesForProfile(
        [absolute],
        session.profileId,
        profilesDir,
        this.context.directory
      );

      if (result.errors.length || result.warnings.length) {
        output.output += `\n\n[workflow-validation]\n${[...result.errors, ...result.warnings]
          .map(
            (item: { severity: string; invariant: string; file: string; message: string }) =>
              `${item.severity}: ${item.invariant} ${item.file}: ${item.message}`
          )
          .join('\n')}`;
      }
    } catch (err) {
      void this.log('warn', 'handleFileToolAfter: validateFiles failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Inlined handler methods (former GuardrailHandler) ────────────────

  private guardrailBefore(args: unknown): void {
    if (!args || typeof args !== 'object') return;
    const input = JSON.stringify(args);
    const guardResult = validateUserInput(input);
    if (guardResult.passed) return;
    void this.log('warn', `Guardrail blocked tool input`, {
      blocked: guardResult.blocked,
      warnings: guardResult.warnings,
    });
    throw new WorkflowBlockedError(
      `Guardrail blocked: ${[...guardResult.blocked, ...guardResult.warnings].join(', ')}`
    );
  }

  private guardrailAfter(toolOutput: string, tool: string): string {
    const sanitized = sanitizeToolOutput(toolOutput, tool);
    if (sanitized.hits.length > 0) {
      void this.log('warn', `Sanitized output from ${tool}`, { hits: sanitized.hits });
    }
    return sanitized.output;
  }

  // ── Inlined handler methods (former ConsentHandler) ──────────────────

  private async consentBefore(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown
  ): Promise<boolean> {
    if (tool !== 'question' || !args) return false;
    const questionArgs = args as { questions?: Array<{ question?: string }> };
    const questionText = questionArgs?.questions?.[0]?.question ?? '';
    if (questionText) {
      await this.consentOrchestrator.before(sessionID, callID, questionText);
    }
    return true;
  }

  private async consentAfter(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { title: string; output: string; metadata: unknown }
  ): Promise<boolean> {
    if (tool !== 'question') return false;
    await this.consentOrchestrator.after(sessionID, callID, args, output);
    return true;
  }

  // ── Inlined handler methods (former CommitPermit) ──────────────────

  private async commitBefore(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { args: unknown }
  ): Promise<boolean> {
    if (tool === 'bash') {
      const command = extractBashCommand(args);
      if (hasForbiddenGitSubcommand(command)) {
        void this.log('warn', `Blocked forbidden git command`, { callID: callID, command });
        throw new WorkflowBlockedError(
          'Direct git commit/push is blocked. Use commit-task.ts instead.'
        );
      }
      if (isCommitTaskCommand(command)) {
        await this.handleCommitTaskBefore(sessionID, callID, output);
      }
    }
    return true;
  }

  // ── Inlined handler methods (former MutationHandler) ─────────────────

  private async mutationBefore(
    tool: string,
    sessionID: string,
    callID: string,
    output: { args: unknown }
  ): Promise<void> {
    if (!this.mutatingTools.has(tool)) return;
    await this.mutationOrchestrator.beginMutation({ sessionID, callID }, output);
  }

  private async mutationAfter(
    tool: string,
    sessionID: string,
    callID: string,
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    if (!this.mutatingTools.has(tool)) return;
    await this.mutationOrchestrator.finishMutation(
      { sessionID, callID, metadata: output.metadata },
      (text) => {
        output.output += text;
      }
    );
  }

  /**
   * После каждого инструмента пытаемся применить переходы.
   */
  private async transitionAfter(sessionID: string): Promise<void> {
    const session = await this.store.load(sessionID);
    if (!session) return;
    try {
      await this.mutationOrchestrator.applyTransitions(session);
      await this.store.save(session);
    } catch (err) {
      void this.log('warn', 'transitionAfter: tryApplyTransitions failed', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * SDK-004: List active OpenCode sessions — delegates to mutation orchestrator.
   */
  async listSessions(): Promise<Array<{ id: string; title?: string }>> {
    return this.mutationOrchestrator.listSessions();
  }

  /**
   * Handle dispose — clean up all resources.
   */
  async handleDispose(): Promise<void> {
    this.queue.clear();
    this.mutationOrchestrator.dispose();
    void this.log('info', 'StateMachineRuntime disposed');
  }

  /**
   * Handle config — register sm-* commands and state-machine agent.
   */
  async handleConfig(config: Config): Promise<void> {
    config.command = config.command || {};
    config.agent = config.agent || {};
    config.command['sm-status'] = {
      template: 'tell the user the current state-machine workflow status for this session',
      description: 'Show the current state-machine workflow session status',
      agent: 'state-machine',
      subtask: true,
    };
    config.command['sm-list'] = {
      template: 'list all state-machine workflow sessions and their stages',
      description: 'List all active workflow sessions',
      agent: 'state-machine',
      subtask: true,
    };
    config.command['sm-session'] = {
      template: 'manage the state-machine workflow session: create, switch, or show details',
      description: 'Create, switch, or inspect a workflow session',
      agent: 'state-machine',
      subtask: true,
    };
    config.command['sm-profile'] = {
      template:
        'switch the state-machine profile: shows available profiles or switches to a given profile ID',
      description: 'Switch the active workflow profile',
      agent: 'state-machine',
      subtask: true,
    };

    config.agent['state-machine'] = {
      model: config.model,
      description:
        'State machine workflow agent — manages sessions, profiles, stages, and gates. Use for sm-* commands.',
      mode: 'subagent',
      color: '#6366F1',
    };

    // Sync agents for all profiles on startup — complete before returning
    // so agents are discoverable by the host when config resolves.
    try {
      await this.syncAllProfileAgents();
    } catch (err) {
      void this.log('error', 'syncAllProfileAgents failed after retry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async syncAllProfileAgents(): Promise<void> {
    try {
      const entries = await readdir(this.profilesDir, { withFileTypes: true });
      const profileIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

      for (const profileId of profileIds) {
        const profileJsonPath = join(this.profilesDir, profileId, 'profile.json');
        if (!existsSync(profileJsonPath)) continue;
        await syncProfileAgents(profileId, this.projectDir, (msg) => this.log('info', msg, {}));
      }
    } catch (err) {
      void this.log('warn', 'syncAllProfileAgents failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Produce the Hooks object that the plugin system consumes.
   */
  get hooks(): Hooks {
    return {
      config: async (config) => {
        await this.handleConfig(config);
      },
      tool: {
        // Compatibility alias for the original public tool name.
        'workflow.create': tool({
          description: 'Create a new state-machine workflow session',
          args: {
            schemaId: z.string().optional().describe('Schema ID without .yaml (e.g., android)'),
          },
          execute: async (args: { schemaId?: string }, ctx: ToolContext) =>
            this.handleCreateWorkflow(args, ctx),
        }),
        'workflow.list': tool({
          description:
            'List all available workflow profiles (schemas). Returns profilesDir and profile IDs with descriptions.',
          args: {},
          execute: async () => {
            const profiles = await listProfiles(this.profilesDir);
            const lines = [`profilesDir: ${this.profilesDir}`];
            for (const p of profiles) {
              const parts: string[] = [p.id];
              if (p.description) parts.push(`desc: ${p.description}`);
              if (p.extends) parts.push(`extends: ${p.extends}`);
              if (p.schemas && p.schemas.length > 0) parts.push(`schemas: ${p.schemas.join(', ')}`);
              lines.push(`  - ${parts.join(' | ')}`);
            }
            if (profiles.length === 0) lines.push('  (no profiles found)');
            const output = lines.join('\n');
            return { output };
          },
        }),
        'workflow.consent': tool({
          description:
            'Request file consent from the operator. Reads files from disk, ' +
            'computes integrity evidence, and prepares the session for a consent question. ' +
            'Call this BEFORE asking the user with the `question` tool.',
          args: {
            files: z
              .union([z.array(z.string()).min(1), z.string().min(1)])
              .describe('Paths to files (e.g. [".opencode/plan.md"])'),
            summary: z.string().min(1).max(400).describe('Short summary of what the file proposes'),
            grant: z.string().default('grant').describe('Label for the approve option'),
            decline: z.string().default('decline').describe('Label for the decline option'),
          },
          execute: async (
            args: {
              files: string[];
              summary: string;
              grant?: string;
              decline?: string;
            },
            ctx: ToolContext
          ) => {
            return this.handleWorkflowConsent(args, ctx);
          },
        }),
        'workflow.tasks-set': tool({
          description:
            'Replace task list. listKey is auto-detected from active loop run or defaults to "implementation". ' +
            'Cannot replace a list while work is in progress. IDs are auto-assigned.',
          args: {
            tasks: z.union([
              z.array(
                z.object({
                  path: z.string().min(1),
                  status: z.enum(TASK_STATUS),
                  title: z.string().optional(),
                  declaredScope: z.string().optional(),
                  branch: z.string().optional(),
                  manifest: z.array(z.string()).optional(),
                  testResult: z.enum(['pass', 'fail', 'unknown']).optional(),
                })
              ),
              z.string().min(1),
            ]),
          },
          execute: async (
            args: { tasks: Omit<SetTasksInput['tasks'][number], 'id'>[] | string },
            ctx: ToolContext
          ) => this.handleTasksSet(args, ctx),
        }),
        'workflow.tasks-get': tool({
          description: 'Read one named workflow task list',
          args: { listKey: z.string().min(1) },
          execute: async (args: { listKey: string }, ctx: ToolContext) =>
            this.handleTasksGet(args, ctx),
        }),
        'workflow.tasks-set-status': tool({
          description: 'Set a workflow task status by global task ID',
          args: { taskId: z.string().regex(/^task-[0-9]+$/), status: z.enum(TASK_STATUS) },
          execute: async (
            args: { taskId: string; status: (typeof TASK_STATUS)[number] },
            ctx: ToolContext
          ) => this.handleTasksSetStatus(args, ctx),
        }),
        'workflow.tasks-resolve-decision': tool({
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
      },
      'chat.message': async (input, output) => {
        await this.handleChatMessage(input, output);
      },
      'tool.execute.before': async (input, output) => {
        this.log('info', `[DEBUG] tool.execute.before raw input`, {
          raw: JSON.stringify(input, null, 0).slice(0, 2000),
        });
        await this.handleToolBefore(input, output);
      },
      'tool.execute.after': async (input, output) => {
        this.log('info', `[DEBUG] tool.execute.after raw input`, {
          raw: JSON.stringify(input, null, 0).slice(0, 2000),
        });
        await this.handleToolAfter(input, output);
      },
      event: async (input) => {
        await this.handleEvent(input);
      },
      'experimental.chat.system.transform': async (input, output) => {
        await this.handleSystemTransform(input, output);
      },
      'experimental.session.compacting': async (input, output) => {
        await this.handleSessionCompacting(input, output);
      },
      'experimental.chat.messages.transform': async (input, output) => {
        await this.handleMessagesTransform(input, output);
      },
      dispose: async () => {
        await this.handleDispose();
      },
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a new StateMachineRuntime and return its Hooks.
 */
export function createRuntime(context: PluginInput): Hooks {
  const runtime = new StateMachineRuntime(context);
  return runtime.hooks;
}
