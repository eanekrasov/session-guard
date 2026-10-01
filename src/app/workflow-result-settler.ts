import { parseWorkflowResult } from '../domain/evidence.ts';
import type { LogFn } from './logger.ts';
import type { MutationOrchestrator } from './mutation-orchestrator.ts';
import { computeChangeScope, changedAgainstHead } from './change-scope.ts';
import { validateFilesForProfile, SUPPORTED_EXTENSIONS } from './invariants.ts';
import { findTask, isOpenLoopRun } from '../session/helpers.ts';
import type { ActiveOperation, WorkflowSession } from '../session/session-schema.ts';
import { matchesScope } from './scope-match.ts';
import { resolve, relative, isAbsolute } from 'node:path';
import type { TaskToolArgs } from './tool-args.ts';
import { existsSync } from 'node:fs';
import { WorkflowGateService, type GateServiceDependencies } from './workflow-gate-service.ts';

export interface WorkflowResultSettlerInput {
  tool: string;
  session: WorkflowSession;
  callID: string;
  args: unknown;
  output: { output: string };
  projectDir: string;
  profilesDir: string;
  operation?: ActiveOperation;
  fileToolArgs?: { filePath?: unknown; path?: unknown; file?: unknown };
}

export interface WorkflowResultSettler {
  settle(input: WorkflowResultSettlerInput): Promise<void>;
}

type SettlerDependencies = GateServiceDependencies & {
  load?: (sessionId: string) => Promise<WorkflowSession | null>;
  save?: (session: WorkflowSession) => Promise<void>;
};

export class WorkflowResultSettlerImpl implements WorkflowResultSettler {
  private readonly resolveEngine: SettlerDependencies['resolveEngine'];
  private readonly log: LogFn;
  private readonly gateService: WorkflowGateService;

  constructor(dependencies: SettlerDependencies | MutationOrchestrator, log?: LogFn) {
    if ('resolveEngine' in dependencies && log === undefined) {
      this.resolveEngine = dependencies.resolveEngine.bind(dependencies);
      this.log = async () => undefined;
    } else {
      this.resolveEngine = (dependencies as MutationOrchestrator).resolveEngine.bind(dependencies);
      this.log = log ?? (async () => undefined);
    }
    this.gateService = new WorkflowGateService({
      resolveEngine: this.resolveEngine,
      log: this.log,
    });
  }

  async settle(input: WorkflowResultSettlerInput): Promise<void> {
    const {
      tool,
      session,
      callID,
      args,
      output,
      projectDir,
      profilesDir,
      operation,
      fileToolArgs,
    } = input;

    // 1a. Invariants for a `task` move — runs before workflow result processing
    if (tool === 'task') {
      await this.runTaskInvariants(session, callID, projectDir, profilesDir, operation);
    }

    // 1b. Workflow result — the runtime normalizes V1/V2 delegated tools to `task`.
    if (tool === 'task') {
      await this.processWorkflowResult(session, callID, args, output);
    }

    // 1d. File tool — run invariants on written/edited files
    if (fileToolArgs) {
      await this.runFileToolInvariants(session, output, projectDir, profilesDir, fileToolArgs);
    }
  }

  private async runTaskInvariants(
    session: WorkflowSession,
    callID: string,
    projectDir: string,
    profilesDir: string,
    operation?: ActiveOperation
  ): Promise<void> {
    if (!projectDir) return;
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
      changed = await computeChangeScope(projectDir, frame);
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
        const absoluteFiles = existingFiles.map((file) => resolve(projectDir, file));
        const result = await validateFilesForProfile(
          absoluteFiles,
          session.profileId,
          profilesDir,
          projectDir
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

    // Accumulate changed files for delivery permit (fixes delegated workflow bug)
    // Mirror processScopeAndInvariants: union then prune to what still differs from HEAD
    const accumulated = new Set([...(session.changedFiles ?? []), ...changed]);
    session.changedFiles = changedAgainstHead(projectDir)
      .filter((file) => accumulated.has(file))
      .sort();

    // Store check result on the operation
    const op = session.activeOperations[callID];
    if (op) op.checks = passed ? 'passed' : 'failed';
  }

  private async runFileToolInvariants(
    session: WorkflowSession,
    output: { output: string },
    projectDir: string,
    profilesDir: string,
    fileToolArgs: { filePath?: unknown; path?: unknown; file?: unknown }
  ): Promise<void> {
    if (!projectDir) return;

    const candidate = fileToolArgs?.filePath ?? fileToolArgs?.path ?? fileToolArgs?.file;
    if (typeof candidate !== 'string') return;

    const absolute = resolve(projectDir, candidate);
    const local = relative(projectDir, absolute);

    if (isAbsolute(local) || local.startsWith('..') || !SUPPORTED_EXTENSIONS.test(local)) return;
    if (!existsSync(absolute)) return;

    try {
      const result = await validateFilesForProfile(
        [absolute],
        session.profileId,
        profilesDir,
        projectDir
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
      const message = err instanceof Error ? err.message : String(err);
      output.output += `\n\n[workflow-validation-unavailable]\n${message}`;
      void this.log('warn', 'handleFileToolAfter: invariants did not run', {
        sessionID: session.sessionId,
        error: message,
      });
    }
  }

  private async processWorkflowResult(
    session: WorkflowSession,
    callID: string,
    args: unknown,
    output: { output: string }
  ): Promise<void> {
    const parsed = parseWorkflowResult(output.output);
    const markerCount = [
      ...output.output.matchAll(/<workflow-result>[\s\S]*?<\/workflow-result>/gu),
    ].length;
    const reportingAgent = this.dispatchedAgent(args);
    const operation = session.activeOperations[callID];

    void this.log('debug', 'workflow-result.settlement.started', {
      sessionID: session.sessionId,
      callID,
      currentStage: session.currentStage,
      revision: session.revision,
      operation: operation
        ? { taskId: operation.taskId, runId: operation.runId, status: operation.status }
        : null,
      reportingAgent,
    });
    void this.log('debug', 'Plugin workflow-result hook input', {
      sessionID: session.sessionId,
      callID,
      markerCount,
      markerDetected: markerCount > 0,
      parsedGate: parsed?.gate,
      parsedStatus: parsed?.status,
      outputLength: output.output.length,
      outputHasWorkflowResult: output.output.includes('<workflow-result>'),
      outputHasDsmlToolResult: output.output.includes('<｜DSML｜tool-result>'),
      currentStage: session.currentStage,
      tool: 'task',
    });

    if (!parsed) {
      void this.log('debug', 'workflow-result.settlement.missing', {
        sessionID: session.sessionId,
        callID,
        currentStage: session.currentStage,
        operation: operation?.taskId ?? null,
      });
      const silent = this.runForCall(session, operation);
      if (silent) {
        output.output +=
          `\n\n[workflow-result-missing]\n` +
          `Stage ${silent.stage} of ${silent.taskId} ended without a ` +
          `<workflow-result> marker, so nothing was recorded and the task did not move.`;
      }
      this.releaseVerdict(session, callID);
      return;
    }

    // Delegate to the shared gate service (same logic used by workflow-gate-set tool)
    const result = await this.gateService.applyGate({
      session,
      gate: parsed.gate,
      status: parsed.status,
      reportingAgent,
      callID,
      operation,
    });

    void this.log('debug', 'workflow-result.settlement.completed', {
      sessionID: session.sessionId,
      callID,
      gate: parsed.gate,
      status: parsed.status,
      currentStage: session.currentStage,
      kind: result.kind,
      revision: session.revision,
    });

    switch (result.kind) {
      case 'replayed':
        output.output += `\n\n[workflow-result-replayed]\n${result.reason}`;
        void this.log('warn', 'Workflow result detected replayed', {
          sessionID: session.sessionId,
          callID,
        });
        break;
      case 'stale':
        output.output += `\n\n[workflow-result-stale]\n${result.reason}`;
        void this.log('warn', 'Workflow result from a finished round', {
          sessionID: session.sessionId,
          callID,
        });
        break;
      case 'rejected':
        output.output += `\n\n[workflow-result-rejected]\n${result.reason}`;
        void this.log('warn', 'Workflow result rejected', {
          sessionID: session.sessionId,
          callID,
          reason: result.reason,
        });
        break;
      case 'recorded':
        workflow_result_recorded: {
          const { verdict } = result;
          void this.log('debug', 'workflow-result.settlement.recorded', {
            sessionID: session.sessionId,
            callID,
            gate: verdict.gate,
            status: verdict.status,
            stage: verdict.stage,
            moved: verdict.moved,
          });
        }
        break;
    }

    this.releaseVerdict(session, callID);
  }

  private releaseVerdict(session: WorkflowSession, callID: string): void {
    delete session.activeOperations[callID];
    if (session.verdictProvenance) delete session.verdictProvenance[callID];
  }

  private runForCall(
    session: WorkflowSession,
    operation: ActiveOperation | undefined
  ): { stage: string; taskId: string } | undefined {
    const run = session.loopRuns[operation?.runId ?? ''];
    if (run && isOpenLoopRun(run)) return { stage: run.stage, taskId: run.taskId };
    return undefined;
  }

  private dispatchedAgent(args: unknown): string | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const taskArgs = args as TaskToolArgs;
    return taskArgs.subagent_type ?? taskArgs.agent ?? taskArgs.type;
  }
}
