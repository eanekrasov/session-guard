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
import { toGuardContext, type SessionGuardEngine } from '../domain/engine.ts';
import { admitAction, commandMatches, type AdmissionRequest } from '../domain/action-admission.ts';
import type { ActionEntry } from '../schema/profile-schema.ts';
import { SessionExecutor } from './session-executor.ts';
import { SessionQueue } from './session-queue.ts';
import { sanitizeToolOutput, validateUserInput } from './guardrails.ts';
import { listProfiles } from '../public-api.ts';
import {
  schemaToEngineConfig,
  selectSchema,
  MutationOrchestrator,
} from './mutation-orchestrator.ts';
import { ConsentOrchestrator } from './consent-orchestrator.ts';
import { parseWorkflowResult } from '../domain/evidence.ts';
import type { LogFn } from './logger.ts';
import { createLogFn } from './logger.ts';
import {
  extractBashCommand,
  hasForbiddenGitSubcommand,
  isReadOnlyBashCommand,
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
  MutationTaskSchema,
  type LoopRun,
  type MutationTask,
  type WorkflowSession,
} from '../session/session-schema.ts';
import { matchesScope, scopesIntersect } from './scope-match.ts';
import { extractToolCallPaths } from '../rules/message-paths.ts';
import { parsePatch } from '../rules/file-observation.ts';
import { captureBaseline, changedAgainstHead, computeChangeScope } from './change-scope.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative, dirname, basename } from 'node:path';
import { validateFilesForProfile, SUPPORTED_EXTENSIONS } from './invariants.ts';
import { parseConsentRequest, evidenceOf, type ConsentManifest } from './consent.ts';
import { canonicalizePlan, computeSha256 } from './sdd-artifacts.ts';
import { TaskApi, type SetTasksInput } from './task-api.ts';
import { resolveConfig } from '../public-api.ts';
import { sessionsDir, profilesDir as getProfilesDir, opencodeStateDir } from './paths.ts';
import { OpenCodeRulesRuntime } from '../rules/runtime.ts';
import { MatchedRulesStateStore } from '../rules/matched-rules-state.ts';
import { syncProfileAgents } from './profile-agent-sync.ts';
import { agentIsAllowed } from './agent-names.ts';
import { schemaId } from './profile-resolver.ts';
import { WorkflowBlockedError } from './blocked-error.ts';
import { createReporter, errorMessage, type Reporter } from './report.ts';

export { schemaToEngineConfig };

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

// ─── SessionGuardRuntime ─────────────────────────────────────────────────────

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

class SessionGuardRuntime {
  private store: WorkflowStore;
  private queue: SessionQueue;
  private executor: SessionExecutor;
  private mutationOrchestrator: MutationOrchestrator;
  private consentOrchestrator: ConsentOrchestrator;
  private taskApi: TaskApi;
  private context: PluginInput;
  private log: LogFn;
  private report: Reporter;
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
    return (await this.loadGoverning(sessionID)) !== null;
  }

  /**
   * Load the workflow session that governs a hook's session id.
   *
   * A hook fires with the id of the session the tool ran in; a dispatched
   * subagent's is a child, and no workflow file is written under a child id.
   * Loading by the raw id therefore found nothing, and the plugin governed
   * only what the orchestrator did itself — which is not where the work
   * happens.
   */
  private async loadGoverning(sessionID: string | undefined): Promise<WorkflowSession | null> {
    if (!sessionID) return null;
    return this.store.load(await this.executor.rootOf(sessionID));
  }

  /**
   * The host's parent for a session, or null when it is a root or unknown.
   *
   * `parentID` lives on the host's session record, never in our session file,
   * so this is the only place the chain can come from. A dispatched subagent
   * runs in a child session; without this the parent's task scope, invariants
   * and queue never saw its writes.
   */
  private async resolveHostParent(sessionID: string): Promise<string | null> {
    try {
      const result = await this.context.client.session.get({ path: { id: sessionID } });
      const session = (result as { data?: { parentID?: string } }).data;
      const parent = session?.parentID;
      return typeof parent === 'string' && parent !== '' ? parent : null;
    } catch (err) {
      void this.log('debug', 'resolveHostParent: session.get failed', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Normalize tool identifiers to lowercase for consistent comparison.
   * SDK may send tool names in any casing (Bash, bash, BASH).
   */
  private normalizeTool(tool: string): string {
    return tool.toLowerCase();
  }

  constructor(context: PluginInput, paths?: RuntimePaths) {
    this.context = context;
    this.log = createLogFn(context.client);
    this.report = createReporter(context.client, this.log);
    // The store lives outside the project, under OpenCode's own state
    // directory. It used to be told so through process.env, which the plugin
    // set from the first project it happened to initialise for — so a second
    // project in the same process read the first's value.
    const storeDir = paths?.storeDir ?? sessionsDir(opencodeStateDir());
    this.store = new WorkflowStore(storeDir, this.log);
    this.executor = new SessionExecutor(this.store, this.log, (sessionID) =>
      this.resolveHostParent(sessionID)
    );
    this.queue = new SessionQueue(this.log, (sessionID) => this.resolveHostParent(sessionID));

    this.profilesDir = paths?.profilesDir ?? getProfilesDir(context.directory);
    this.projectDir = context.directory;

    this.mutationOrchestrator = new MutationOrchestrator(
      this.store,
      this.executor,
      this.projectDir,
      this.profilesDir,
      this.log,
      context.client.session
    );
    this.consentOrchestrator = new ConsentOrchestrator(
      this.store,
      this.executor,
      this.projectDir,
      this.profilesDir,
      context.client.session,
      this.log
    );
    this.taskApi = new TaskApi(
      this.store,
      async (profileId, schemaId) => this.declaredTaskLists(profileId, schemaId),
      this.executor
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
    const session = await this.loadGoverning(ctx.sessionID);
    if (!session) return null;

    // `tasks-get` is open to any caller and catches its own errors; the
    // task-control tools resolve the engine here, before their handler's own
    // try. A broken profile therefore escaped `workflow-tasks-set` as a raw
    // ProfileConfigurationError while the same error became readable tool
    // output next door. Two neighbouring tools, one broken profile, two shapes
    // of failure.
    let allowed: string[];
    try {
      const engine = await this.mutationOrchestrator.resolveEngine(
        session.profileId,
        session.schemaId
      );
      allowed = engine.getTaskControlAgents();
    } catch (error) {
      const message = `${toolName} is refused: ${errorMessage(error)}`;
      this.report(message, { sessionID: ctx.sessionID, tool: toolName });
      return { output: message, metadata: { refused: true, tool: toolName } };
    }
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

  /**
   * The task lists the session's own workflow declares, by its `loop:` sources.
   *
   * This used to flatten every schema in the profile. A profile may hold
   * several independent workflows and a session runs exactly one of them, so
   * that accepted a list belonging to a workflow nobody is running.
   */
  private async declaredTaskLists(profileId: string, schemaId?: string): Promise<string[]> {
    const profile = await resolveConfig(profileId, this.profilesDir);
    const schema = selectSchema(profileId, profile.schemas, schemaId);
    return Object.values(schema.stages ?? {})
      .map((stage) => stage.loop)
      .filter((loop): loop is string => loop !== undefined && loop !== '$currentTask.id');
  }

  private async handleTasksSet(
    args: { tasks: Omit<SetTasksInput['tasks'][number], 'id'>[] | string; listKey?: string },
    ctx: { sessionID: string; agent?: string }
  ): Promise<ToolResult> {
    const refusal = await this.refuseUnlessTaskController('workflow-tasks-set', ctx);
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

      // Move listKey resolution and ID computation into the executor scope
      // so they see consistent state with the setTasks call
      const result = await this.executor.run(ctx.sessionID, async (tx) => {
        if (!tx.session) {
          return { output: 'No workflow session found. Call workflow-create first.' } as ToolResult;
        }

        // Which list to fill. The fallback used to be the literal
        // 'implementation' — the base profile's loop source written into the
        // core — so a schema declaring `loop: jobs` was refused with "Unknown
        // task list: implementation" and could never be started: no run exists
        // until tasks are dispatched, and no tasks could be set without a run.
        //
        // The workflow itself says which lists it has. A caller may name one;
        // otherwise the run in flight decides, and failing that the schema's
        // single declared list. With several and none named, the choice is the
        // caller's to make and guessing at it fills the wrong list.
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

        // Compute next available task ID across all existing lists
        const maxExisting = Object.values(tx.session.tasks)
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
    const refusal = await this.refuseUnlessTaskController('workflow-tasks-set-status', ctx);
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
    const refusal = await this.refuseUnlessTaskController('workflow-tasks-resolve-decision', ctx);
    if (refusal) return refusal;
    try {
      let output = 'No pending retry decision found';
      await this.executor.run(ctx.sessionID, async (tx) => {
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

  /**
   * Handle workflow-create tool.
   */
  async handleCreateWorkflow(
    args: { schemaId?: string },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    const requested = args.schemaId ?? process.env.HARNESS_SCHEMA_ID ?? process.env.HARNESS_PROFILE;

    // `<profileId>/<schemaId>`. Schema names are unique only inside their
    // profile, so an unqualified name has to name the profile instead; the
    // schema is then the profile's, provided it holds exactly one.
    const slash = requested?.indexOf('/') ?? -1;
    const requestedProfileId = slash === -1 ? requested : requested!.substring(0, slash);
    const requestedSchemaId = slash === -1 ? undefined : requested!.substring(slash + 1);

    const profiles = await listProfiles(this.profilesDir);
    const resolvedProfileId = profiles.some((profile) => profile.id === requestedProfileId)
      ? requestedProfileId
      : undefined;

    if (!resolvedProfileId) {
      if (profiles.length === 0) {
        const message =
          `No workflow profiles found in ${this.profilesDir}. ` +
          `Set SESSION_GUARD_PROFILES_DIR or create a profile to use workflow tools.`;
        this.report(message, { profilesDir: this.profilesDir });
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

    // Check if session already exists
    const existing = await this.store.load(ctx.sessionID);
    if (existing) {
      return { output: `Session already exists: ${ctx.sessionID}` };
    }

    let resolvedSchemaId: string;
    let engine: SessionGuardEngine;
    try {
      const resolved = await resolveConfig(resolvedProfileId, this.profilesDir);
      resolvedSchemaId = selectSchema(resolvedProfileId, resolved.schemas, requestedSchemaId).id;
      engine = await this.mutationOrchestrator.resolveEngine(resolvedProfileId, resolvedSchemaId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix =
        error instanceof ProfileConfigurationError
          ? 'Profile configuration error'
          : 'Profile resolution error';
      return { output: `${prefix}: ${message}` };
    }

    // The stage this workflow starts in, not the base profile's. The compiler
    // has always worked it out; nothing read it, so every session began in
    // `planning` whether the schema declared that stage or not.
    const session = createSession(
      ctx.sessionID,
      resolvedProfileId,
      resolvedSchemaId,
      engine.getInitialStage()
    );
    // Creation path — no enclosing executor transaction available.
    // Direct store.save is appropriate: the session does not yet
    // exist, so executor.run() would load null and no enclosing
    // persistence exists.
    await this.store.save(session);

    void this.log('info', `Workflow session created`, {
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

  /**
   * Handle workflow-consent tool.
   *
   * Reads plan files from disk, computes integrity evidence, stores a consent
   * request on the session, and returns a consent tag. The agent then calls
   * question(...) to show the user the approve/decline choice.
   */
  async handleWorkflowConsent(
    args: {
      files: string[];
      summary: string;
      /**
       * Имя согласия — то же, что схема пишет в `consent:` на переходе.
       * Отсутствует — `plan`, как было всегда.
       */
      type?: string;
      grant?: string;
      decline?: string;
    },
    ctx: { sessionID: string }
  ): Promise<ToolResult> {
    const session = await this.loadGoverning(ctx.sessionID);
    if (!session) {
      return { output: 'No workflow session found. Call workflow-create first.' };
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
      ...(args.type ? { type: args.type } : {}),
    };
    const manifestEvidence = evidenceOf(manifest);

    // This save is outside any enclosing executor transaction — the consent
    // tool runs independently rather than inside a hook's executor.run().
    // Direct store.save is correct here.
    await this.store.save(session);

    void this.log('info', 'workflow-consent: consent request prepared', {
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
    const session = sessionID ? await this.loadGoverning(sessionID) : null;
    if (!session) {
      void this.log('debug', 'chat.message: no session found', { sessionID });
      return;
    }

    const stage = session.currentStage;
    const activeGates = session.stageGateResults
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
    await this.executor.run(input.sessionID, async (tx) => {
      // 0. Opt-in gate — no workflow session means no plugin mechanics at all.
      if (!tx.session) return;

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

      // 3b. Task scope — refuse a write/read outside the active task's declared
      // scope, before the tool runs. `bash` carries no path argument, so it is
      // not enforced here (task-scope spec) — an out-of-scope bash write is
      // caught only after the fact, via the per-move baseline diff.
      // scopeBefore and actionsBefore receive tx.session directly since
      // they already run inside executor.run() — no redundant loadGoverning needed.
      await this.scopeBefore(tool, tx.session, args);

      // 3c. Stage actions — вторая ось рядом с переходами: те решают, можно ли
      // уйти со стадии, эта — можно ли сделать что-то, оставаясь на ней. Стоит
      // до выдачи delivery permit и до жизненного цикла мутации, потому что
      // отвечает на вопрос «этот вызов вообще разрешён здесь». Когда стадия
      // ничего не объявила, здесь же применяется дефолт ядра про прямой git.
      await this.actionsBefore(tool, tx.session, input.callID, args);

      // 4. Commit Permit: block forbidden git commands, issue deliveryPermit for commit-task
      await this.commitBefore(tool, input.sessionID, input.callID, args, output);

      // 5. Mutation guard (Bash/Write tool) — beginMutation captures this
      // move's own baseline frame (move-invariants D1/D2/D3) before the tool
      // runs. `task`'s baseline is captured in handleTaskBefore instead, since
      // `task` never joins mutatingTools (D2).
      await this.mutationBefore(tool, input.sessionID, input.callID, args, output);
    });
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

    // Captured before admission (D2): this is real I/O (git status + a hash
    // per dirty path) that must not run inside the serialised session queue.
    // A refused admission wastes one snapshot — the rare path.
    const frame = await this.safeCaptureBaseline();

    await this.executor.run(sessionID, async (tx) => {
      if (!tx.session) return;
      if (tx.session.activeOperations[callID]) {
        this.blockTaskAdmission(`Native call ${callID} is already correlated`);
        return;
      }

      let profile;
      let engine;
      try {
        const profileRoot = getProfilesDir(this.context.directory);
        profile = await resolveConfig(tx.session.profileId, profileRoot);
        engine = await this.mutationOrchestrator.resolveEngine(
          tx.session.profileId,
          tx.session.schemaId
        );
      } catch (error) {
        this.blockTaskAdmission(
          `Cannot resolve workflow admission profile: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }

      const derivedStageId = engine.deriveStage(tx.session);
      tx.session.currentStage = derivedStageId;
      const derivedStage = engine.getStages()[derivedStageId];
      if (!derivedStage?.loop || nestedStages(derivedStage).length === 0) {
        this.blockTaskAdmission(`Stage ${derivedStageId} does not declare an executable task loop`);
        return;
      }

      // The loop that owns this task's list, which is not always the stage the
      // session is in: a loop stage may nest a loop of its own
      // (`loop: $currentTask.id`), and that inner loop's tasks live in a list
      // keyed by the parent task's id. Admission looked only in the outer
      // loop's list, so a schema declaring a nested loop was accepted and its
      // child tasks were then always "not eligible" — the shape could be
      // written and never run.
      const owner = this.resolveAdmissionLoop(tx.session, derivedStageId, derivedStage, taskId);
      if (!owner) {
        this.blockTaskAdmission(
          `Workflow task ${taskId} is not eligible in loopStage ${derivedStageId}`
        );
        return;
      }
      const { stageId: loopStageId, stage: loopStage, listKey } = owner;
      if (nestedStages(loopStage).length === 0) {
        this.blockTaskAdmission(`Stage ${loopStageId} does not declare an executable task loop`);
        return;
      }
      // A loop that names no dispatch runs one task at a time. Requiring the
      // field made every profile repeat boilerplate, and forgetting it stopped
      // the loop with a message about a loop that is plainly declared. The
      // inner loop's own dispatch, roster and budget govern its tasks.
      // `serial` carries no maxConcurrent — the schema's own union says so, and
      // the check below short-circuits on the strategy before reading it.
      const dispatch = loopStage.dispatch ?? { strategy: 'serial' as const };

      const tasks = tx.session.tasks[listKey]!;
      const task = tasks.find((candidate) => candidate.id === taskId)!;

      const nonterminalRuns = Object.values(tx.session.loopRuns).filter(
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
      if (allowedAgents?.length && !agentIsAllowed(agent, allowedAgents, tx.session.profileId)) {
        this.blockTaskAdmission(
          `Agent ${agent} is not allowed in stage ${stageId}. Allowed: ${allowedAgents.join(', ')}`
        );
        return;
      }
      // task.editingAgents restricts who may hold this task's mutating tool
      // calls at all. Agent identity is only known at dispatch time — a
      // native tool.execute.before hook carries no agent — so this is
      // enforced here, refusing the dispatch itself rather than each write.
      //
      // Whether this stage is one where work happens is asked of its roster,
      // not of its `gates`. `stage.gates?.length === 0` was the old test, and
      // it is false when a stage declares no `gates:` at all — which is most
      // stages — so the check was skipped for exactly the case it was written
      // for and a task naming its own editors admitted anyone.
      //
      // A stage whose roster admits an editor is a stage where work happens.
      // No roster means anyone may run there, editors included. A workflow
      // that declares no editors at all cannot classify its stages, and this
      // stays silent rather than guess — every shipped profile declares them.
      const editors = engine.getEditingAgents();
      const roster = stage.allowedAgents ?? loopStage.allowedAgents;
      const stageMayEdit =
        editors.length > 0 &&
        (roster === undefined ||
          roster.some((candidate) => agentIsAllowed(candidate, editors, tx.session!.profileId)));

      if (
        stageMayEdit &&
        task.editingAgents?.length &&
        !agentIsAllowed(agent, task.editingAgents, tx.session.profileId)
      ) {
        this.blockTaskAdmission(
          `Agent ${agent} may not edit ${taskId}. editingAgents: [${task.editingAgents.join(', ')}]`
        );
        return;
      }
      // A stage that declares gates is waiting for several verdicts, so it may
      // have one call per gate at a time — review and qa run together. Every
      // other stage is one call at a time, and the same agent may never hold
      // two: one agent cannot judge the same work twice at once.
      const running = Object.values(tx.session.activeOperations).filter(
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

      // Используем нормализованный контекст с фактами выбранной задачи — как при
      // проверке переходов. Сырой session имеет gates в виде массива Gate[], а
      // toGuardContext проецирует в факты с Record<string, GateStatus>, и включает
      // контекст задачи (task.id, task.status и т.д.) для guard-выражений.
      const guardContext = toGuardContext(tx.session, {
        id: task.id,
        status: task.status,
        listKey,
      });
      if (
        stage.entryGuards?.some(
          (guard) => !engine.evaluateGuard(guard, guardContext, { currentLoopListKey: listKey })
        )
      ) {
        this.blockTaskAdmission(`Entry guard rejected stage ${stageId}`);
        return;
      }

      const activeRuns = Object.values(tx.session.loopRuns).filter((run) => isOpenLoopRun(run));
      if (!existingRun) {
        const rejection = this.taskAdmissionRejection(
          dispatch,
          tasks,
          taskId,
          activeRuns,
          firstNestedStageId(loopStage)!,
          tx.session,
          listKey
        );
        if (rejection) {
          this.blockTaskAdmission(rejection);
          return;
        }
      }

      const runId = existingRun?.id ?? nextLoopRunId(tx.session);
      if (!existingRun) {
        tx.session.loopRuns[runId] = {
          id: runId,
          taskId,
          listKey,
          ancestry: this.resolveTaskAncestry(tx.session.tasks, listKey),
          stage: stageId,
          status: 'running',
          gates: {},
          round: 0,
        };
        task.status = 'running';
      }
      tx.session.activeOperations[callID] = {
        callId: callID,
        runId,
        taskId,
        agent,
        kind: 'task',
        status: 'running',
        startedAt: new Date().toISOString(),
        // The occupancy of the stage this call belongs to. A verdict that
        // arrives after the task has moved on belongs to a round that is over.
        round: tx.session.loopRuns[runId]?.round ?? 0,
        // The pre-move snapshot captured above, before admission. A missing
        // frame (no projectDir) leaves this unset — see D5.
        baseline: frame,
      };

      upsertActiveTaskContext(tx.session, {
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
          typeof description === 'string' ? description.slice(match![0].length).trimStart() : '',
      });
    });
  }

  private blockTaskAdmission(reason: string): never {
    throw new WorkflowBlockedError(reason);
  }

  /**
   * The loop stage that owns the list a task lives in, and that list's key.
   *
   * Loops nest: a stage cycling over `parents` may declare an inner stage
   * cycling over `$currentTask.id`, whose tasks live in a list named after the
   * parent task. Only the outer loop was ever consulted, so those children
   * were refused as ineligible by a workflow that had accepted the shape.
   *
   * The outer loop wins when it owns the task, so nothing about an ordinary
   * flat loop changes; otherwise exactly one nested loop must own it.
   */
  private resolveAdmissionLoop(
    session: WorkflowSession,
    outerStageId: string,
    outerStage: StageDef,
    taskId: string
  ): { stageId: string; stage: StageDef; listKey: string } | null {
    const owners: Array<{ stageId: string; stage: StageDef; listKey: string }> = [];
    const walk = (stageId: string, stage: StageDef): void => {
      if (stage.loop) {
        const listKey = this.resolveAdmissionListKey(session, stage.loop, taskId);
        if (listKey) owners.push({ stageId, stage, listKey });
      }
      for (const nested of nestedStages(stage)) walk(`${stageId}/${nested.id}`, nested);
    };
    walk(outerStageId, outerStage);

    return (
      owners.find((owner) => owner.stageId === outerStageId) ??
      (owners.length === 1 ? owners[0]! : null)
    );
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

  /**
   * Two scopes meet here, and telling them apart is the whole job.
   *
   * A `dispatch:` strategy governs one cycle: `serial` means one task of *that
   * list* at a time, and `maxConcurrent` counts *that list's* runs. These read
   * `cycleRuns`. Counting every open run in the session instead made a parent
   * refuse its own child — the parent occupies `parents`, the child's cycle
   * owns `task-1`, and the parent's run turned the child away with «Serial task
   * cycle admits only the next unfinished task». The parent then waited for a
   * child that was not allowed to start.
   *
   * `writeScope` overlap is the other scope and stays session-wide: two tasks
   * writing the same paths break invariant attribution whether or not they
   * belong to the same cycle, because the diff is split by path, not by list.
   */
  private taskAdmissionRejection(
    dispatch: NonNullable<StageDef['dispatch']>,
    tasks: MutationTask[],
    taskId: string,
    activeRuns: LoopRun[],
    firstStageId: string,
    session: WorkflowSession,
    listKey: string
  ): string | null {
    const cycleRuns = activeRuns.filter((run) => run.listKey === listKey);

    if (dispatch.strategy !== 'serial' && cycleRuns.length >= dispatch.maxConcurrent) {
      return `Task cycle concurrency limit ${dispatch.maxConcurrent} is exhausted`;
    }

    const taskIndex = tasks.findIndex((task) => task.id === taskId);
    const firstUnfinishedIndex = tasks.findIndex(
      (task) => task.status === 'pending' || task.status === 'running'
    );
    if (dispatch.strategy === 'serial') {
      if (taskIndex !== firstUnfinishedIndex || cycleRuns.length > 0) {
        return `Serial task cycle admits only the next unfinished task`;
      }
      return null;
    }

    // Non-overlap applies to EVERY non-serial strategy (`parallel` and
    // `serial_with_overlap`), not just `parallel`: disjoint writeScope is
    // what makes invariant attribution possible at all, by splitting the
    // diff by path instead of by time. `serial` admits one run at a time
    // and needs nothing here. An absent/empty writeScope overlaps nothing,
    // so a read-only task is always admissible (task-scope spec).
    const incoming = tasks[taskIndex];
    const overlapping = activeRuns.find((run) => {
      const running = findTask(session, run.taskId);
      return running !== undefined && scopesIntersect(incoming?.writeScope, running.writeScope);
    });
    if (overlapping) {
      let message = `Task ${taskId}'s writeScope overlaps running task ${overlapping.taskId}`;
      if (dispatch.strategy === 'parallel') {
        // Only `parallel` has an alternative: under `serial_with_overlap`
        // the order is strict, so there is no other admissible task and the
        // answer is always "wait".
        const runningTaskIds = new Set(activeRuns.map((run) => run.taskId));
        const admissibleNow = tasks.filter(
          (task) =>
            task.id !== taskId &&
            !runningTaskIds.has(task.id) &&
            (task.status === 'pending' || task.status === 'running') &&
            !activeRuns.some((run) => {
              const running = findTask(session, run.taskId);
              return running !== undefined && scopesIntersect(task.writeScope, running.writeScope);
            })
        );
        if (admissibleNow.length > 0) {
          message += `; admissible now: ${admissibleNow.map((task) => task.id).join(', ')}`;
        }
      }
      return message;
    }

    if (dispatch.strategy === 'parallel') return null;

    if (taskIndex === 0) return cycleRuns.length === 0 ? null : 'First task is already active';
    const priorTask = tasks[taskIndex - 1];
    const priorRun = cycleRuns.find((run) => run.taskId === priorTask.id);
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
   * P1-012: Handle commit-task command — issue deliveryPermit.
   */
  private async handleCommitTaskBefore(
    sessionID: string,
    callID: string,
    output: { args: unknown }
  ): Promise<void> {
    const session = await this.loadGoverning(sessionID);
    // No workflow session means the plugin does not apply — skip silently
    // rather than blocking a call it does not govern.
    if (!session) return;

    const preCommitHead = this.getPreCommitHead();
    session.deliveryPermit = {
      callID,
      preCommitHead,
      // Pruned again here, not just trusted: a move may have put a file back
      // and then nothing else ran, so the list was last pruned before the
      // revert. The permit is the one place this is load-bearing, and it is
      // issued at the moment the commit is about to happen.
      expectedFiles: changedAgainstHead(this.projectDir).filter((file) =>
        session.changedFiles.includes(file)
      ),
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
    await this.executor.run(input.sessionID, async (tx) => {
      // 0. Opt-in gate — no workflow session means no plugin mechanics at all.
      if (!tx.session) return;

      // Normalize tool name to lowercase (SDK may send any casing)
      const tool = this.normalizeTool(input.tool);

      // 1. Guardrails — always sanitize output
      output.output = this.guardrailAfter(output.output, tool);

      // 1a. Invariants for a `task` move — MUST run before handleWorkflowResult
      // (1b): that step computes movement and deletes the operation (D3). A
      // verdict produced after either is a verdict about a move that already
      // left.
      await this.invariantsAfter(tool, tx.session, input.callID);

      // 1b. Workflow result — parse and record <workflow-result> tags
      await this.handleWorkflowResult(tool, tx.session, input.callID, input.args, output);

      // 1c. Rules — PostToolUse evaluation + file observations
      await this.rulesRuntime.handleToolExecuteAfter(input, output);

      // 1d. File tool — run invariants on written/edited files
      await this.handleFileToolAfter(tool, input, output);

      // 2. Commit Permit: verify HEAD changed after commit-task
      if (tool === 'bash') {
        await this.handleCommitTaskAfter(tx.session, input.callID, output);
      }

      // 3. Question tool — consent request (approve/decline plan)
      if (tool === 'question') {
        await this.consentAfter(tool, input.sessionID, input.callID, input.args, output);
      }

      // 5. Finish mutation (Bash/Write tool) — единственный путь finalization.
      //    MutationOrchestrator.finishMutation вычисляет scope, валидацию
      //    инвариантов и устанавливает gate через один вызов domain finishMutation.
      await this.mutationAfter(tool, input.sessionID, input.callID, input.args, output);

      // 6. Try transitions — после любого инструмента проверяем, можно ли перейти
      await this.transitionAfter(tx.session, (fn) => tx.deferAfterSave(fn));
    });
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
    session: WorkflowSession,
    callID: string,
    output: { output: string }
  ): Promise<void> {
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
      // `--root` is what makes the repository's first commit answerable.
      // Without it diff-tree compares against a parent, and the initial commit
      // has none — so it printed nothing, the empty list was read as "cannot
      // determine which files this commit contains", and a correct first
      // commit was rejected with the workflow stuck in `commit`.
      const result = spawnSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', currentHead],
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
      void this.log('warn', 'handleCommitTaskAfter: git diff-tree failed', {
        sessionID: session.sessionId,
      });
    }

    const expected = [...(session.deliveryPermit.expectedFiles ?? [])].sort();
    const reject = (reason: string, extra: Record<string, unknown>): void => {
      session.deliveryPermit = null;
      output.output += `\n\n[workflow-commit-rejected]\n${reason}\nThe commit ${currentHead} stands in git, but no delivery receipt was recorded: the workflow stays in \`commit\`. Reconcile the worktree and run the commit step again.`;
      void this.log('warn', `handleCommitTaskAfter: ${reason}`, {
        sessionID: session.sessionId,
        callID,
        ...extra,
      });
    };

    if (committed === null || committed.length === 0) {
      reject(
        'Could not determine which files commit ' +
          currentHead +
          ' contains, so the commit cannot be verified against the permit.',
        { expected }
      );
      return;
    }

    if (JSON.stringify(committed) !== JSON.stringify(expected)) {
      reject(
        `Committed files do not match the delivery permit.\nExpected: ${expected.join(', ') || '(none)'}\nCommitted: ${committed.join(', ')}`,
        { expected, committed }
      );
      return;
    }

    session.deliveryReceipt = currentHead;
    session.deliveryPermit = null;
    void this.log('info', `Commit detected: ${currentHead}`, {
      sessionID: session.sessionId,
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

    const session = await this.loadGoverning(input.sessionID);
    if (!session) return;

    const lines = [...output.system];
    lines.push(`[workflow session: ${session.sessionId}]`);
    lines.push(`[workflow profile: ${session.profileId}]`);

    // Read the stage from the session. `currentStage` is written by
    // tryApplyTransitions, and by workflow-create before that from the
    // compiled workflow's own first stage — so it is always set, and the
    // `?? 'planning'` that stood here was a fallback to the base profile's
    // first stage that could never fire and would have been wrong if it did.
    const stage = session.currentStage;
    lines.push(`[workflow stage: ${stage}]`);

    const gateLines = session.stageGateResults
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
        `[workflow pending decision: ${decision.subject} ${decision.subjectId} ${decision.kind}; use workflow-tasks-resolve-decision (no taskId needed)]`
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
  async handleEvent(
    event: EventEnvelope & {
      event: { properties?: Record<string, unknown> & { part?: EventPart } };
    }
  ): Promise<void> {
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
    if (typeof rulesSessionID === 'string' && (await this.hasWorkflowSession(rulesSessionID))) {
      await this.rulesRuntime.handleEvent(event);
    }
  }

  private async markTaskOperationInterrupted(callId: string): Promise<void> {
    const sessionIds = await this.store.list();
    for (const sessionID of sessionIds) {
      const loaded = await this.store.load(sessionID);
      const loadedOperation = loaded?.activeOperations[callId];
      if (!loadedOperation || loadedOperation.status !== 'running') continue;
      await this.executor.run(sessionID, async (tx) => {
        const operation = tx.session?.activeOperations[callId];
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

  /**
   * Шаг 1a `tool.execute.after` — снять diff собственного baseline-кадра хода
   * `task` и добавить изменённые файлы в `session.changedFiles`, из которых
   * строится delivery permit.
   *
   * Проверяются только файлы, попавшие в пересечение диффа с `writeScope`
   * задачи: это нарушение самого хода, а не всего грязного дерева.
   *
   * Вердикт пишется в `operation.checks`, откуда `handleWorkflowResult`
   * сворачивает его в `run.checks` — строго после проверки свежести раунда,
   * чтобы старая операция не трогала вердикт текущего. Порядок относительно
   * `handleWorkflowResult` (D3) обязателен: тот считает движение и удаляет
   * операцию, так что вердикт, написанный после него, мёртв.
   *
   * Отсутствующий кадр (D5) — админ отказал, не-workflow `task`, плагин
   * поставили посреди вызова — это один `warn` и выход. Никогда не
   * подставлять пустой baseline и не валить задачу из-за одного этого.
   */
  private async invariantsAfter(
    tool: string,
    session: WorkflowSession,
    callID: string
  ): Promise<void> {
    if (tool !== 'task') return;
    if (!this.projectDir) return;

    const operation = session.activeOperations[callID];
    if (!operation || operation.status !== 'running') return;

    const frame = operation.baseline;
    if (!frame) {
      void this.log('warn', 'invariantsAfter: no baseline frame for this move', {
        callID,
        taskId: operation.taskId,
        runId: operation.runId,
      });
      return;
    }

    const task = findTask(session, operation.taskId);

    let changed: string[];
    try {
      changed = await computeChangeScope(this.projectDir, frame);
    } catch (error) {
      void this.log('warn', 'invariantsAfter: change scope computation failed', {
        callID,
        error: error instanceof Error ? error.message : String(error),
      });
      changed = [];
    }

    const inScope = task?.writeScope?.length
      ? changed.filter((file) => matchesScope(file, task.writeScope))
      : changed;

    let passed = true;
    const existingFiles = inScope.filter((file) => SUPPORTED_EXTENSIONS.test(file));
    if (existingFiles.length > 0) {
      try {
        const absoluteFiles = existingFiles.map((file) => resolve(this.projectDir, file));
        const result = await validateFilesForProfile(
          absoluteFiles,
          session.profileId,
          this.profilesDir,
          this.projectDir
        );
        passed = result.errors.length === 0;
      } catch (error) {
        passed = false;
        void this.log('warn', 'invariantsAfter: invariant validation threw', {
          callID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Direct mutation — no nested enqueue. The enclosing executor.run handles
    // the single conditional save after the action completes.
    const op = session.activeOperations[callID];
    if (op) op.checks = passed ? 'passed' : 'failed';

    // What this move produced is part of what the workflow delivers. The
    // list was computed above to run invariants over and then dropped, so a
    // workflow whose work is entirely delegated — every task dispatched to a
    // subagent, which is what the shipped workflow does — reached `commit`
    // with `changedFiles` empty. The permit is built from that list, so it
    // expected nothing, and the commit that carried the work was refused
    // with 'Committed files do not match the delivery permit. Expected:
    // (none)'.
    const accumulated = new Set([...(session.changedFiles ?? []), ...changed]);
    session.changedFiles = changedAgainstHead(this.projectDir)
      .filter((file) => accumulated.has(file))
      .sort();
  }

  private async handleWorkflowResult(
    tool: string,
    session: WorkflowSession,
    callID: string,
    args: unknown,
    output: { output: string }
  ): Promise<void> {
    if (tool !== 'task') return;
    const parsed = parseWorkflowResult(output.output);
    const reportingAgent = this.dispatchedAgent(args);

    // One call, one verdict. The branches below delete the operation once
    // they have recorded a result, so a replay of the same call arrived with
    // no operation to attribute it to and was read as a verdict about the
    // whole body of work — replaying two task results closed the session's
    // own gates and moved it past validation unvalidated.
    session.processedResultCallIDs ??= [];
    if (session.processedResultCallIDs.includes(callID)) {
      output.output +=
        `\n\n[workflow-result-replayed]\n` +
        `The result for ${callID} has already been recorded. Nothing was recorded again.`;
      void this.log('warn', 'Workflow result replayed', { sessionID: session.sessionId, callID });
      return;
    }
    if (parsed || session.activeOperations[callID]) {
      session.processedResultCallIDs.push(callID);
      // Bounded: a session's call ids only ever accumulate.
      if (session.processedResultCallIDs.length > 500) {
        session.processedResultCallIDs.splice(0, session.processedResultCallIDs.length - 500);
      }
    }

    const operation = session.activeOperations[callID];
    const run = operation && operation.runId ? session.loopRuns[operation.runId] : undefined;
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
        sessionID: session.sessionId,
        taskId: task.id,
        resultRound: operation.round,
        currentRound: run.round,
      });
      delete session.activeOperations[callID];
      return;
    }

    // Свернуть вердикт хода (написан `invariantsAfter`, шаг 1a) в
    // `run.checks` — строго после проверки свежести раунда выше. Старая
    // операция не должна трогать вердикт текущего раунда даже временно.
    if (run && operation?.checks) {
      run.checks = operation.checks;
    }

    if (operation) {
      if (run && task) {
        if (operation.status !== 'running') {
          return;
        }
        const loopStage = parsed ? await this.resolveLoopStage(session, run.listKey) : null;
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
              sessionID: session.sessionId,
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
              sessionID: session.sessionId,
              stage: run.stage,
              reported: parsed.stage,
              declared: declaredGates,
            });
            delete session.activeOperations[callID];
            return;
          }
          run.gates[parsed.stage] = parsed.status === 'pass' ? 'passed' : 'failed';
        }

        // Verification is recorded only after all admission checks pass —
        // agent authority, declared gates, and round freshness. A result
        // rejected above leaves nothing in session.verifications.
        if (parsed) {
          session.verifications.push({
            stage: parsed.stage,
            status: parsed.status === 'pass' ? 'confirmed' : 'rejected',
            recordedAt: new Date().toISOString(),
          });
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
            sessionID: session.sessionId,
            taskId: task.id,
            stage: run.stage,
            outputPreview: output.output.slice(0, 200),
          });
        }

        if (failed || passed) {
          const engine = await this.mutationOrchestrator.resolveEngine(
            session.profileId,
            session.schemaId
          );
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
          } else if (failed && movement.kind === 'unreachable') {
            // No transition took the failure and there is no applicable route
            // at all — the loop's own retry budget decides: back to the first
            // stage, or a decision for the operator. When stayKind is
            // 'blocked' the route exists but a guard or consent explicitly
            // shut it — retry must NOT override that policy decision.
            this.recordTaskRetryFailure(session, run, task, loopStage);
          } else if (movement.kind === 'blocked') {
            // A route exists but a guard or consent explicitly shut it —
            // a policy decision, not a missing route. It must NOT be
            // silently dropped, and it must NOT spend retry budget.
            output.output +=
              `\n\n[workflow-task-blocked]\n` +
              `${task.id} stayed at ${run.stage}: ${movement.reason}`;
            void this.log('warn', 'Workflow task movement blocked', {
              sessionID: session.sessionId,
              taskId: task.id,
              stage: run.stage,
              reason: movement.reason,
            });
          } else if (passed && movement.kind === 'unreachable') {
            // A passing stage with nowhere applicable to go — surfaced
            // rather than silently dropped, matching the failure case above.
            output.output +=
              `\n\n[workflow-task-unreachable]\n` +
              `${task.id} stayed at ${run.stage}: ${movement.reason}`;
            void this.log('warn', 'Workflow task movement unreachable on pass', {
              sessionID: session.sessionId,
              taskId: task.id,
              stage: run.stage,
              reason: movement.reason,
            });
          }
        }
      }
      // Cleanup always follows movement recording above, for every
      // movement kind — move, complete, blocked, and unreachable.
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
        sessionID: session.sessionId,
        stage: parsed.stage,
        status: parsed.status,
        summary: parsed.summary,
      });
    }
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
      const engine = await this.mutationOrchestrator.resolveEngine(
        session.profileId,
        session.schemaId
      );
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
  private async resolveLoopStage(
    session: WorkflowSession,
    listKey: string
  ): Promise<StageDef | null> {
    const engine = await this.mutationOrchestrator.resolveEngine(
      session.profileId,
      session.schemaId
    );
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
      args?: unknown;
    },
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    if (!this.fileTools.has(tool)) return;

    const args =
      input.args && typeof input.args === 'object'
        ? (input.args as { filePath?: unknown; path?: unknown; file?: unknown })
        : undefined;
    const candidate = args?.filePath ?? args?.path ?? args?.file;
    if (typeof candidate !== 'string') return;

    const absolute = resolve(this.context.directory, candidate);
    const local = relative(this.context.directory, absolute);

    // Проверяем, что файл внутри проекта и имеет поддерживаемое расширение
    if (isAbsolute(local) || local.startsWith('..') || !SUPPORTED_EXTENSIONS.test(local)) return;

    // Проверяем существование файла
    if (!existsSync(absolute)) return;

    // Загружаем профиль сессии и запускаем инварианты
    try {
      const session = await this.loadGoverning(input.sessionID);
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
      // The checks did not run, so the file is not known to be clean. Say so
      // where the agent reads it rather than leaving an unexplained silence.
      const message = errorMessage(err);
      output.output += `\n\n[workflow-validation-unavailable]\n${message}`;
      this.report(`handleFileToolAfter: invariants did not run — ${message}`, {
        sessionID: input.sessionID,
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

  /**
   * Действующая стадия — вложенная, когда открыт прогон цикла.
   *
   * Работа задачи идёт на стадии внутри `loop`, и объявления принадлежат ей.
   * Внешняя стадия остаётся ответом, когда цикла нет или вложенная своих
   * действий не объявила — тот же `??`, которым разрешается `allowedAgents`.
   */
  private async actingStageActions(session: WorkflowSession): Promise<ActionEntry[] | undefined> {
    let engine: SessionGuardEngine;
    try {
      engine = await this.mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
    } catch {
      // Нечитаемый профиль — это «стадия ничего не объявила», а не бросок
      // отсюда. Вызов всё равно умрёт ниже по цепочке, с внятной причиной, а
      // здесь мы обязаны успеть применить дефолт ядра.
      return undefined;
    }
    const outerId = engine.deriveStage(session);
    const outer = engine.getStages()[outerId];

    if (!outer) return undefined;

    const openRun = Object.values(session.loopRuns ?? {}).find((run) => isOpenLoopRun(run));
    if (openRun) {
      const nested = nestedStages(outer).find((entry) => entry.id === openRun.stage);
      if (nested?.actions) return nested.actions;
      return outer.actions;
    }

    // Прогон ещё не открыт, но стадия объявляет цикл — значит первый же ход
    // его и откроет, на первой вложенной стадии. Судить такой ход по внешней
    // стадии неверно: она про раздачу задач, работа идёт внутри.
    //
    // Это ровно тот момент, который сломал host-smoke: `beginMutation`
    // открывает прогон ПОСЛЕ допуска действия, поэтому первая правка каждой
    // задачи приходила сюда без открытого прогона и отказывалась — «stage does
    // not declare the action 'edit'». Прогон открывает `resolveMutationRun` по
    // тому же признаку (`operation-lifecycle.ts`), и решение о стадии обязано
    // совпадать с ним, иначе допуск и жизненный цикл расходятся.
    if (outer.loop) {
      const first = nestedStages(outer)[0];
      if (first?.actions) return first.actions;
    }
    return outer.actions;
  }

  /**
   * Отказать вызову, которого действующая стадия не объявляла.
   *
   * Отображение инструмента в действие — единственное место, где оно живёт.
   * `commit-task` приезжает как `bash`, но это доставка, а не команда, и
   * действие у неё своё. Инструменты вне словаря (`read`, `glob`, `task`)
   * этим механизмом не управляются вовсе.
   */
  private async actionsBefore(
    tool: string,
    session: WorkflowSession,
    callID: string,
    args: unknown
  ): Promise<void> {
    let request: AdmissionRequest | null = null;
    if (tool === 'bash') {
      request = { action: 'bash', command: extractBashCommand(args) };
    } else if (this.fileTools.has(tool)) {
      request = { action: 'edit', paths: this.scopeTargetPaths(tool, args) };
    }
    if (!request) return;

    const actions = await this.actingStageActions(session);
    if (actions === undefined) {
      this.forbiddenGitDefault(tool, callID, args);
      return;
    }

    const engine = await this.mutationOrchestrator.resolveEngine(
      session.profileId,
      session.schemaId
    );
    const facts = toGuardContext(session);
    const verdict = admitAction(actions, request, (expression) =>
      engine.evaluateGuard(expression, facts)
    );
    if (!verdict.allowed) {
      void this.log('warn', 'Action refused by the stage', {
        sessionID: session.sessionId,
        tool,
        reason: verdict.reason,
      });
      throw new WorkflowBlockedError(verdict.reason ?? 'Action refused by the stage');
    }
  }

  // ── Inlined handler methods (former CommitPermit) ──────────────────

  /**
   * Дефолт ядра: прямой `git commit`/`push` запрещён.
   *
   * Именно дефолт, а не закон. Правило git-специфично, а схема здесь общая — и
   * стадия, объявившая `actions:`, отвечает на этот вопрос сама: её список
   * исчерпывающий, так что `git commit` отказывается уже потому, что его не
   * покрыла ни одна запись. Профиль, которому доставка нужна обычным
   * `git commit`, объявляет её у действия `commit` и получает.
   *
   * Работает, пока стадия молчит — и когда профиль не читается: тогда
   * `actingStageActions` возвращает `undefined`, и запрет всё равно
   * применяется. Сам по себе он ничего не открывает: `git commit` не
   * read-only, поэтому на битом профиле вызов и так упрётся в `resolveEngine`
   * внутри `mutationBefore`.
   */
  private forbiddenGitDefault(tool: string, callID: string, args: unknown): void {
    if (tool !== 'bash') return;
    const command = extractBashCommand(args);
    if (!hasForbiddenGitSubcommand(command)) return;
    void this.log('warn', `Blocked forbidden git command`, { callID: callID, command });
    throw new WorkflowBlockedError(
      'Direct git commit/push is blocked. Declare a delivery action with delivers: true.'
    );
  }

  private async commitBefore(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { args: unknown }
  ): Promise<boolean> {
    if (await this.isCommitDelivery(tool, sessionID, args)) {
      await this.handleCommitTaskBefore(sessionID, callID, output);
    }
    return true;
  }

  // ── Inlined handler methods (former MutationHandler) ─────────────────

  /**
   * The task whose scope governs the tool call currently in flight.
   *
   * The native `tool.execute.before`/`tool.execute.after` hooks carry no
   * agent identity for arbitrary tools (only `tool`, `sessionID`, `callID`),
   * so a write/edit/read cannot be attributed to a specific concurrent task
   * by agent. When exactly one task operation is running for the session,
   * its task is unambiguously the one in flight; with zero or several
   * running at once, scope cannot be safely attributed and is not enforced
   * here — the per-move baseline diff (move-invariants) still catches an
   * out-of-scope change after the fact.
   */
  /**
   * `captureBaseline` shells out to git and throws when the project
   * directory is not a git working tree. A missing frame is D5's "no frame"
   * case, not a reason to fail the tool call that is about to run.
   */
  private async safeCaptureBaseline(): Promise<Record<string, string | null> | undefined> {
    if (!this.projectDir) return undefined;
    try {
      return await captureBaseline(this.projectDir);
    } catch (error) {
      void this.log('warn', 'captureBaseline failed — proceeding without a frame', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Every currently-running task, resolved from `activeOperations`. Used by
   * `scopeBefore` so scope enforcement covers 2+ concurrent tasks — the
   * exact case "Non-overlapping writeScope enables parallel admission"
   * exists to allow — instead of silently no-opping whenever more than one
   * task is running.
   */
  private activeRunningTasks(session: WorkflowSession): MutationTask[] {
    const running = Object.values(session.activeOperations).filter(
      (operation) => operation.status === 'running'
    );
    const tasks: MutationTask[] = [];
    for (const operation of running) {
      const task = findTask(session, operation.taskId);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  /** Target paths a tool call names, made project-relative. Best-effort. */
  private scopeTargetPaths(tool: string, args: unknown): string[] {
    if (tool === 'apply_patch') {
      const patchText =
        args && typeof args === 'object' ? (args as Record<string, unknown>).patchText : undefined;
      if (typeof patchText !== 'string') return [];
      const parsed = parsePatch(patchText);
      return parsed ? parsed.map((observation) => observation.path) : [];
    }
    return extractToolCallPaths(tool, args);
  }

  /**
   * A path with every symlink on it resolved.
   *
   * `resolve` is lexical: it knows nothing about the filesystem, so a symlink
   * inside the project keeps a project-shaped path while pointing anywhere.
   * The file itself may not exist yet — a write creating one — so this walks up
   * to the deepest ancestor that does, resolves that, and puts the rest back.
   */
  private realPathOf(path: string): string {
    const remainder: string[] = [];
    let current = path;
    for (;;) {
      try {
        return join(realpathSync(current), ...remainder);
      } catch {
        const parent = dirname(current);
        if (parent === current) return path;
        remainder.unshift(basename(current));
        current = parent;
      }
    }
  }

  /**
   * A tool-call path, relative to the project root. `null` when unresolvable.
   *
   * Both sides are resolved through the filesystem before they are compared.
   * Checking the written path as a string let a symlink inside an allowed
   * directory carry a write straight out of the project: `allowed/link.ts`
   * matched `allowed/**`, the before-hook admitted it, the file outside was
   * rewritten, and the after-hook recorded `invariants: passed` about work it
   * had never seen. The project root is resolved too, or a symlinked root —
   * `/tmp` on macOS is one — would make every path look external.
   */
  private toProjectRelativePath(path: string): string | null {
    const root = this.realPathOf(this.projectDir);
    const absolute = this.realPathOf(isAbsolute(path) ? path : resolve(this.projectDir, path));
    const rel = relative(root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel;
  }

  private readonly readTools = new Set(['read']);

  private async scopeBefore(tool: string, session: WorkflowSession, args: unknown): Promise<void> {
    const isWrite = this.fileTools.has(tool);
    const isRead = this.readTools.has(tool);
    if (!isWrite && !isRead) return;

    // Check against the UNION of every running task's scope, not a single
    // arbitrarily-picked one (CRITICAL-1 remediation). Admission guarantees
    // running tasks' writeScope never intersect (see taskAdmissionRejection),
    // so a path can match at most one active task's writeScope — "matches
    // some active task's writeScope" is therefore exactly equivalent to
    // "matches the right task's", never an approximation.
    const activeTasks = this.activeRunningTasks(session);
    // Zero running tasks is intentionally left unenforced: a write/read that
    // belongs to no workflow task is not this gate's business.
    if (activeTasks.length === 0) return;

    for (const rawPath of this.scopeTargetPaths(tool, args)) {
      const relPath = this.toProjectRelativePath(rawPath);
      // `null` means the path resolves outside the project. That used to be
      // skipped as none of this gate's business, which is what let a symlink
      // inside an allowed directory carry a write straight out: a scope is a
      // set of project paths, so a target outside the project matches none of
      // them and is refused like any other out-of-scope write.
      const named = relPath ?? `${rawPath} (outside the project)`;

      if (isWrite) {
        const owner =
          relPath === null
            ? undefined
            : activeTasks.find((task) => matchesScope(relPath, task.writeScope));
        if (!owner) {
          const scopes = activeTasks
            .map((task) =>
              task.writeScope?.length
                ? `${task.id}: [${task.writeScope.join(', ')}]`
                : `${task.id}: read-only`
            )
            .join('; ');
          throw new WorkflowBlockedError(
            `${tool} refused: '${named}' is outside every active task's writeScope (${scopes})`
          );
        }
      }
      if (isRead) {
        const restricted = activeTasks.filter((task) => task.readScope?.length);
        if (restricted.length > 0) {
          const owner =
            relPath === null
              ? undefined
              : restricted.find((task) => matchesScope(relPath, task.readScope));
          if (!owner) {
            const scopes = restricted
              .map((task) => `${task.id}: [${task.readScope!.join(', ')}]`)
              .join('; ');
            throw new WorkflowBlockedError(
              `${tool} refused: '${named}' is outside every active task's readScope (${scopes})`
            );
          }
        }
      }
    }
  }

  /**
   * The commit step is delivery, not an edit inside a task loop.
   *
   * `commit-task` runs on the commit stage, where every task and run is
   * finished by definition — that is what got the session there. The generic
   * mutation lifecycle needs exactly one open run or one runnable task, so it
   * refused the commit with "Cannot resolve a single workflow task run for
   * mutation": the commit required completed tasks and the next handler
   * required an unfinished one. The commit has its own lifecycle —
   * `handleCommitTaskBefore` issues the permit, `handleCommitTaskAfter`
   * writes the receipt only once HEAD actually moved — and does not want a
   * second one.
   */
  /**
   * Команды, которыми действующая стадия объявила доставку.
   *
   * Пусто, когда стадия не объявляет действий или ни одна запись не помечена
   * `delivers` — тогда работает зашитый классификатор.
   */
  private async declaredDeliveryCommands(sessionID: string): Promise<string[]> {
    const session = await this.loadGoverning(sessionID);
    if (!session) return [];
    const actions = await this.actingStageActions(session);
    if (!actions) return [];
    return actions
      .filter((entry) => entry.delivers && entry.commands)
      .flatMap((entry) => entry.commands ?? []);
  }

  /**
   * Доставка ли это коммита.
   *
   * Ответ принадлежит схеме: запись с `delivers: true` называет команды, и они
   * же опознают вызов. Пока стадия ничего не объявила, доставка не
   * распознаётся: имя и форма команды принадлежат только schema.
   *
   * Один ответ на все точки вызова намеренно: `commitBefore` выдаёт permit, а
   * `mutationBefore`/`mutationAfter` по этому же признаку НЕ входят в
   * жизненный цикл мутации. Разойдись они — коммит получил бы и permit, и
   * baseline-кадр.
   */
  private async isCommitDelivery(tool: string, sessionID: string, args: unknown): Promise<boolean> {
    if (tool !== 'bash') return false;
    const command = extractBashCommand(args);
    const declared = await this.declaredDeliveryCommands(sessionID);
    return declared.length > 0 && commandMatches(command, declared);
  }

  /**
   * A bash call that only reads is not a move, and must not be one.
   *
   * `bash` is in `mutatingTools` because it usually mutates, so `git status`
   * entered the mutation lifecycle: refused before the plan was approved, and
   * refused afterwards with "Cannot resolve a single workflow task run for
   * mutation" whenever the session had no runnable task. A read had to satisfy
   * a lifecycle built for writes.
   *
   * The classifier is a short allowlist and fails closed, because a command
   * wrongly let through here runs with no baseline and no frame diff behind
   * it.
   */
  private isReadOnlyBash(tool: string, args: unknown): boolean {
    return tool === 'bash' && isReadOnlyBashCommand(extractBashCommand(args));
  }

  private async mutationBefore(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { args: unknown }
  ): Promise<void> {
    if (!this.mutatingTools.has(tool)) return;
    if (await this.isCommitDelivery(tool, sessionID, args)) return;
    if (this.isReadOnlyBash(tool, args)) return;
    await this.mutationOrchestrator.beginMutation({ sessionID, callID }, output);
  }

  private async mutationAfter(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    if (!this.mutatingTools.has(tool)) return;
    if (await this.isCommitDelivery(tool, sessionID, args)) return;
    if (this.isReadOnlyBash(tool, args)) return;
    await this.mutationOrchestrator.finishMutation(
      { sessionID, callID, metadata: output.metadata },
      (text) => {
        output.output += text;
      }
    );
  }

  /**
   * После каждого инструмента пытаемся применить переходы.
   *
   * Принимает `deferAfterSave`, чтобы отложить архивирование до успешного
   * сохранения в вызывающем `executor.run()`.
   */
  private async transitionAfter(
    session: WorkflowSession,
    deferAfterSave: (fn: () => Promise<void>) => void
  ): Promise<void> {
    try {
      const moved = await this.mutationOrchestrator.applyTransitions(session);
      // Запись об исходе — до `save`, иначе она не уедет в архив вместе с
      // сессией, о которой рассказывает.
      if (moved.applied) await this.recordOutcomeIfFinished(session, moved);
      // Сохранение выполняет вызывающий executor.run().
      if (moved.applied) deferAfterSave(() => this.archiveIfFinished(session));
    } catch (err) {
      void this.log('warn', 'transitionAfter: tryApplyTransitions failed', {
        sessionID: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Дошли до конца — сессия уезжает из рантайма в архив.
   *
   * На терминальной стадии workflow закончен, и управлять дальше нечем:
   * ни допуска, ни переходов, ни хода мутации. «Сессии нет» выражается в
   * этом проекте ровно одним способом — `store.load` не находит файла, — и
   * второй способ не-существования заводить нельзя: каждому месту пришлось бы
   * различать два вида отсутствия.
   *
   * Строго ПОСЛЕ `save`: расписка о доставке и последние вердикты пишутся тем
   * же ходом, что и переход, и уехать в архив они должны уже записанными.
   *
   * И только когда переход ДЕЙСТВИТЕЛЬНО применён. Терминальность — свойство
   * стадии, а не события: в схеме без переходов верхнего уровня (движение идёт
   * внутри цикла) терминальна каждая стадия, включая стартовую, и сессия
   * уезжала бы в архив на первом же ходу. Конец — это приход в конец.
   */
  /**
   * Записать, чем и почему кончился workflow.
   *
   * До этого `done` и `failed` выглядели в файле одинаково: стадия и больше
   * ничего. Читатель архива видел исход и не видел причины — «завершилось»,
   * «провалилось» и «застряло» были неразличимы.
   *
   * Причину называет схема, а не ядро: `guard` — условие ребра, по которому
   * ушли в конец, слово в слово как его написал автор профиля. Выдумывать
   * поверх чужих правил свою классификацию значило бы врать в терминах,
   * которых в профиле нет.
   */
  private async recordOutcomeIfFinished(
    session: WorkflowSession,
    moved: { from?: string; to?: string; guard?: string | null }
  ): Promise<void> {
    const stage = moved.to;
    if (!stage) return;

    let engine: SessionGuardEngine;
    try {
      engine = await this.mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
    } catch {
      return;
    }
    if (!engine.isTerminalStage(stage)) return;

    session.outcome = {
      stage,
      from: moved.from ?? session.currentStage,
      guard: moved.guard ?? null,
      failedGates: (session.stageGateResults ?? [])
        .filter((gate) => gate.status === 'failed')
        .map((gate) => gate.id),
      exhaustedBudgets: Object.entries(session.retryBudgets ?? {})
        .filter(([, budget]) => budget.attempts >= budget.maximum)
        .map(([key]) => key),
      recordedAt: new Date().toISOString(),
    };
    void this.log('info', 'Workflow finished', {
      sessionID: session.sessionId,
      stage,
      from: session.outcome.from,
      guard: session.outcome.guard,
      failedGates: session.outcome.failedGates,
      exhaustedBudgets: session.outcome.exhaustedBudgets,
    });
  }

  private async archiveIfFinished(session: WorkflowSession): Promise<void> {
    let engine: SessionGuardEngine;
    try {
      engine = await this.mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
    } catch {
      // Профиль не читается — терминальность определить нечем. Сессия остаётся
      // в рантайме: не убрать законченную безобиднее, чем убрать работающую.
      return;
    }
    if (!engine.isTerminalStage(session.currentStage)) return;

    const archived = await this.store.archive(session.sessionId);
    if (archived) {
      void this.log('info', 'Workflow finished: session archived', {
        sessionID: session.sessionId,
        stage: session.currentStage,
        path: archived,
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
    void this.log('info', 'SessionGuardRuntime disposed');
  }

  /**
   * Handle config — register sm-* commands and session-guard agent.
   */
  async handleConfig(config: Config): Promise<void> {
    config.command = config.command || {};
    config.agent = config.agent || {};
    config.command['sm-status'] = {
      template: 'tell the user the current session-guard workflow status for this session',
      description: 'Show the current session-guard workflow session status',
      agent: 'session-guard',
      subtask: true,
    };
    config.command['sm-list'] = {
      template: 'list all session-guard workflow sessions and their stages',
      description: 'List all active workflow sessions',
      agent: 'session-guard',
      subtask: true,
    };
    config.command['sm-session'] = {
      template: 'manage the session-guard workflow session: create, switch, or show details',
      description: 'Create, switch, or inspect a workflow session',
      agent: 'session-guard',
      subtask: true,
    };
    config.command['sm-profile'] = {
      template:
        'switch the session-guard profile: shows available profiles or switches to a given profile ID',
      description: 'Switch the active workflow profile',
      agent: 'session-guard',
      subtask: true,
    };

    config.agent['session-guard'] = {
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
          ) => {
            return this.handleWorkflowConsent(args, ctx);
          },
        }),
        'workflow-tasks-set': tool({
          description:
            'Replace a workflow task list. Without listKey the list is the one the run in ' +
            'flight is cycling over, or the single list this workflow declares; a workflow ' +
            'declaring several asks for the name. ' +
            'Cannot replace a list while work is in progress. IDs are auto-assigned.',
          args: {
            listKey: z.string().min(1).optional(),
            // Derived from MutationTaskSchema rather than hand-duplicated, so
            // the agent-facing tool surface cannot silently diverge from the
            // domain type (task-scope spec: "argument schema derives from
            // MutationTask").
            tasks: z.union([z.array(MutationTaskSchema.omit({ id: true })), z.string().min(1)]),
          },
          execute: async (
            args: {
              tasks: Omit<SetTasksInput['tasks'][number], 'id'>[] | string;
              listKey?: string;
            },
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
      },
      'chat.message': async (input, output) => {
        await this.handleChatMessage(input, output);
      },
      'tool.execute.before': async (input, output) => {
        // Raw arguments carry file contents and whatever the agent typed, so
        // they belong at `debug`, not on every call at `info`.
        this.log('debug', `tool.execute.before raw input`, {
          raw: JSON.stringify(input, null, 0).slice(0, 2000),
        });
        try {
          await this.handleToolBefore(input, output);
        } catch (error) {
          // A refusal is an error the operator should see: the agent already
          // reads it as a failed tool call, and this is the other two channels.
          this.report(errorMessage(error), {
            tool: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
          });
          throw error;
        }
      },
      'tool.execute.after': async (input, output) => {
        this.log('debug', `tool.execute.after raw input`, {
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
 * Create a new SessionGuardRuntime and return its Hooks.
 */
/**
 * Directories this instance works in, passed rather than exported.
 *
 * `SESSION_GUARD_PROFILES_DIR` / `SESSION_GUARD_STORE_DIR` remain the
 * operator's override, read by `paths.ts`; what must not happen is a plugin
 * instance *writing* them, which turns one project's local default into every
 * later instance's global override.
 */
export interface RuntimePaths {
  storeDir?: string;
  profilesDir?: string;
}

export function createRuntime(context: PluginInput, paths?: RuntimePaths): Hooks {
  const runtime = new SessionGuardRuntime(context, paths);
  return runtime.hooks;
}
