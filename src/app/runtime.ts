import type { Config, Hooks, PluginInput } from '@opencode-ai/plugin';
import { WorkflowStore } from '../session/session-store.ts';
import { SessionExecutor } from './session-executor.ts';
import { sanitizeToolOutput, validateUserInput } from './guardrails.ts';
import {
  schemaToEngineConfig,
  selectSchema,
  MutationOrchestrator,
} from './mutation-orchestrator.ts';
import { ConsentOrchestrator } from './consent-orchestrator.ts';
import type { LogFn } from './logger.ts';
import { createLogFn } from './logger.ts';
import { TaskApi } from './task-api.ts';
import { resolveConfig } from '../public-api.ts';
import { sessionsDir, profilesDir as getProfilesDir, opencodeStateDir } from './paths.ts';
import { OpenCodeRulesRuntime, type MessagesTransformOutput } from '../rules/runtime.ts';
import type { ChatMessageInput, ChatMessageOutput } from '../rules/runtime-chat.ts';
import { MatchedRulesStateStore } from '../rules/matched-rules-state.ts';
import { syncAllProfileAgents } from './profile-agent-sync.ts';
import { WorkflowBlockedError } from './blocked-error.ts';
import { createReporter, errorMessage, type Reporter } from './report.ts';
import { createRuntimeHooks } from './runtime-hooks.ts';
import { createWorkflowToolSurface } from './workflow-tool-surface.ts';
import {
  type RuntimeSessionContext,
  RuntimeSessionContextImpl,
} from './runtime-session-context.ts';
import { WorkflowResultSettlerImpl } from './workflow-result-settler.ts';
import { createTaskAdmission, type TaskAdmission } from './task-admission.ts';
import { createChangeEnforcement, type ChangeEnforcement } from './change-enforcement.ts';
import { createToolExecutionPolicy, type ToolExecutionPolicy } from './tool-execution-policy.ts';
import { createWorkflowLifecycle, type WorkflowLifecycle } from './workflow-lifecycle.ts';

export { schemaToEngineConfig };

// Wrapper around the SDK's tool() that bridges the zod v3↔v4 type gap.
// The SDK bundles zod v4; this project uses zod v3, and the two `ZodRawShape`s
// are not structurally compatible. The bridge is one assertion at that
// boundary, cast to the SDK's own parameter — not `never`, which would swallow
// any wrong shape instead of naming the one intended.
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
  private readonly store: WorkflowStore;
  private readonly executor: SessionExecutor;
  private readonly mutationOrchestrator: MutationOrchestrator;
  private readonly consentOrchestrator: ConsentOrchestrator;
  private readonly taskApi: TaskApi;
  private readonly log: LogFn;
  private readonly report: Reporter;
  private rulesRuntime: OpenCodeRulesRuntime;
  private workflowToolSurface: ReturnType<typeof createWorkflowToolSurface>;
  private readonly sessionContext: RuntimeSessionContext;
  private workflowResultSettler: WorkflowResultSettlerImpl;
  private readonly taskAdmission: TaskAdmission;
  private readonly changeEnforcement: ChangeEnforcement;
  private toolExecutionPolicy: ToolExecutionPolicy;
  private workflowLifecycle: WorkflowLifecycle;
  private readonly fileTools = new Set(['edit', 'write', 'apply_patch']);
  /**
   * Tools that read files and therefore must respect readScope restrictions.
   * Includes 'read' and potentially other read-only tools.
   */
  private readonly readTools = new Set(['read', 'glob', 'grep', 'list']);
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

  constructor(context: PluginInput, paths?: RuntimePaths) {
    this.log = createLogFn(context.client);
    this.report = createReporter(context.client, this.log);
    // The store lives outside the project, under OpenCode's own state
    // directory. It used to be told so through process.env, which the plugin
    // set from the first project it happened to initialise for — so a second
    // project in the same process read the first's value.
    const storeDir = paths?.storeDir ?? sessionsDir(opencodeStateDir());
    this.store = new WorkflowStore(storeDir, this.log);
    const resolveHostParent = async (sessionID: string): Promise<string | null> => {
      try {
        const result = await context.client.session.get({ path: { id: sessionID } });
        const session = result.data;
        const parent = session?.parentID;
        return typeof parent === 'string' && parent !== '' ? parent : null;
      } catch (err) {
        void this.log('debug', 'resolveHostParent: session.get failed', {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };
    this.executor = new SessionExecutor(this.store, this.log, resolveHostParent);
    this.sessionContext = new RuntimeSessionContextImpl(
      this.store,
      this.executor,
      resolveHostParent
    );

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
    this.workflowLifecycle = createWorkflowLifecycle({
      store: this.store,
      executor: this.executor,
      mutationOrchestrator: this.mutationOrchestrator,
      log: this.log,
      projectDir: this.projectDir,
    });
    this.workflowResultSettler = new WorkflowResultSettlerImpl(this.mutationOrchestrator, this.log);
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
      async (profileId, schemaId) => this.declaredTaskListsForTaskApi(profileId, schemaId),
      this.executor
    );

    this.taskAdmission = createTaskAdmission({
      mutationOrchestrator: this.mutationOrchestrator,
      executor: this.executor,
      sessionContext: this.sessionContext,
      profilesDir: this.profilesDir,
      projectDir: this.projectDir,
      log: this.log,
      report: this.report,
    });
    this.changeEnforcement = createChangeEnforcement({
      mutationOrchestrator: this.mutationOrchestrator,
      executor: this.executor,
      projectDir: this.projectDir,
      profilesDir: this.profilesDir,
      log: this.log,
      report: this.report,
      fileTools: this.fileTools,
      mutatingTools: this.mutatingTools,
      readTools: this.readTools,
    });
    this.toolExecutionPolicy = createToolExecutionPolicy({
      guardrails: async (input) => this.guardrailBefore(input.args),
      rules: async (input) =>
        this.rulesRuntime.handleToolExecuteBefore(
          { tool: input.tool, sessionID: input.sessionID, callID: input.callID },
          { args: input.args }
        ),
      consent: async (input) =>
        this.consentBefore(input.tool, input.sessionID, input.callID, input.args),
      taskAdmission: this.taskAdmission,
      taskInput: (input) => ({
        ...input,
        output: input.output ?? { args: input.args },
        session: input.session!,
      }),
      changeEnforcement: this.changeEnforcement,
      changeBeforeInput: (input) => ({
        ...input,
        output: input.output ?? { args: input.args },
        session: input.session!,
      }),
      scope: async () => undefined,
      actions: async () => undefined,
      delivery: async () => undefined,
      mutation: async () => undefined,
    });

    // Initialize the rules sub-system — rule files are discovered lazily
    // inside OpenCodeRulesRuntime on first use.
    const matchedRulesStateStore = new MatchedRulesStateStore();
    this.rulesRuntime = new OpenCodeRulesRuntime({
      client: context.client,
      directory: context.directory,
      projectDirectory: context.directory,
      matchedRulesStateStore,
    });
    this.workflowToolSurface = createWorkflowToolSurface({
      profilesDir: this.profilesDir,
      projectDir: this.projectDir,
      store: this.store,
      executor: this.executor,
      mutationOrchestrator: this.mutationOrchestrator,
      consentOrchestrator: this.consentOrchestrator,
      taskApi: this.taskApi,
      sessionContext: this.sessionContext,
      log: this.log,
      report: this.report,
    });
  }

  /**
   * The task lists the session's own workflow declares, by its `loop:` sources.
   * Used by TaskApi for static list key validation.
   */
  private async declaredTaskListsForTaskApi(
    profileId: string,
    schemaId?: string
  ): Promise<string[]> {
    const profile = await resolveConfig(profileId, this.profilesDir);
    const schema = selectSchema(profileId, profile.schemas, schemaId);
    return Object.values(schema.stages ?? {})
      .map((stage) => stage.loop)
      .filter((loop): loop is string => loop !== undefined && loop !== '$currentTask.id');
  }

  /**
   * Handle [chat.message] — run guardrails on user input, capture baseline,
   * then evaluate rules.
   */
  async handleChatMessage(input: ChatMessageInput, output?: ChatMessageOutput): Promise<void> {
    const sessionID = input?.sessionID;
    const session = sessionID ? await this.sessionContext.load(sessionID) : null;
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

    // TODO: guardrails для chat.message будет реализован, когда SDK начнёт передавать текст сообщения. Пока блокировка работает в handleToolBefore.
    void validateUserInput;

    // Delegate to rules sub-system
    await this.rulesRuntime.handleChatMessage(input, output ?? {});
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
      const tool = this.sessionContext.normalizeTool(input.tool);

      // SDK передаёт args вызова в output.args для tool.execute.before,
      // НЕ в input.args (в input.args нет поля args по типам SDK).
      const args = output.args;

      // Every refusal below throws WorkflowBlockedError: the host cancels the
      // tool call only when this hook rejects. See blocked-error.ts.

      await this.toolExecutionPolicy.before({
        tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args,
        session: tx.session,
        output,
      });
    });
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
      const tool = this.sessionContext.normalizeTool(input.tool);

      // 1. Guardrails — always sanitize output
      output.output = this.guardrailAfter(output.output, tool);

      // 1c. Rules — PostToolUse evaluation + file observations
      await this.rulesRuntime.handleToolExecuteAfter(input, output);

      // 1a/1b/1d. Invariants + Workflow result + File tool — all in settler
      const operation = tx.session.activeOperations[input.callID];
      const args = input.args as { filePath?: unknown; path?: unknown; file?: unknown } | undefined;
      await this.workflowResultSettler.settle({
        tool,
        session: tx.session,
        callID: input.callID,
        args: input.args,
        output,
        projectDir: this.projectDir,
        profilesDir: this.profilesDir,
        operation,
        fileToolArgs: args,
      });

      // 2. Commit Permit: verify HEAD changed after commit-task
      if (tool === 'bash') {
        await this.workflowLifecycle.handleCommitTaskAfter(tx.session, input.callID, output);
      }

      // 3. Question tool — consent request (approve/decline plan)
      if (tool === 'question') {
        await this.consentAfter(tool, input.sessionID, input.callID, input.args, output);
      }

      // 5. Finish mutation (Bash/Write tool) — единственный путь finalization.
      //    MutationOrchestrator.finishMutation вычисляет scope, валидацию
      //    инвариантов и устанавливает gate через один вызов domain finishMutation.
      //    Now handled by changeEnforcement in toolExecutionPolicy.

      // 6. Try transitions — после любого инструмента проверяем, можно ли перейти
      await this.workflowLifecycle.afterTool(tx.session, tx);
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

    const session = await this.sessionContext.load(input.sessionID);
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
    if (!(await this.sessionContext.has(input.sessionID))) return;

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
    output: MessagesTransformOutput
  ): Promise<void> {
    await this.rulesRuntime.handleMessagesTransform(_input, output);
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
    await this.workflowLifecycle.handleEvent(event);

    // Rules are a per-session mechanic. The rules sub-system reads the session
    // from `event.properties.sessionID` (not from `part`), so gate on that same
    // field: no workflow session, no rules.
    const rulesSessionID = event.event.properties?.['sessionID'];
    if (typeof rulesSessionID === 'string' && (await this.sessionContext.has(rulesSessionID))) {
      await this.rulesRuntime.handleEvent(event);
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
   * Handle dispose — clean up all resources.
   */
  async handleDispose(): Promise<void> {
    this.executor.clear();
    this.workflowLifecycle.dispose();
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
      await syncAllProfileAgents(this.projectDir, (msg) => this.log('info', msg, {}));
    } catch (err) {
      void this.log('error', 'syncAllProfileAgents failed after retry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get hooks(): Hooks {
    return createRuntimeHooks({
      config: (config) => this.handleConfig(config),
      chatMessage: this.handleChatMessage.bind(this),
      before: async (input, output) => {
        const typedInput = input as Parameters<SessionGuardRuntime['handleToolBefore']>[0];
        const typedOutput = output as Parameters<SessionGuardRuntime['handleToolBefore']>[1];
        await this.log('debug', `tool.execute.before raw input`, {
          raw: JSON.stringify(typedInput, null, 0).slice(0, 2000),
        });
        try {
          await this.handleToolBefore(typedInput, typedOutput);
        } catch (error) {
          this.report(errorMessage(error), {
            tool: typedInput.tool,
            sessionID: typedInput.sessionID,
            callID: typedInput.callID,
          });
          throw error;
        }
      },
      after: async (input, output) => {
        const typedInput = input as Parameters<SessionGuardRuntime['handleToolAfter']>[0];
        const typedOutput = output as Parameters<SessionGuardRuntime['handleToolAfter']>[1];
        await this.log('debug', `tool.execute.after raw input`, {
          raw: JSON.stringify(typedInput, null, 0).slice(0, 2000),
        });
        await this.handleToolAfter(typedInput, typedOutput);
      },
      event: (input) =>
        this.handleEvent(input as Parameters<SessionGuardRuntime['handleEvent']>[0]),
      systemTransform: (input, output) =>
        this.handleSystemTransform(input as never, output as never),
      compacting: (input, output) => this.handleSessionCompacting(input as never, output as never),
      messagesTransform: (input, output) =>
        this.handleMessagesTransform(input as never, output as MessagesTransformOutput),
      dispose: () => this.handleDispose(),
      tools: this.workflowToolSurface.createTools(),
    });
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
