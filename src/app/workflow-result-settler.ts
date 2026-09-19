import { approve } from '../domain/approvals.ts';
import { toGuardContext, type SessionGuardEngine } from '../domain/engine.ts';
import { parseWorkflowResult } from '../domain/evidence.ts';
import { nextTaskStage, TASK_DONE } from '../domain/task-movement.ts';
import { agentIsAllowed } from './agent-names.ts';
import type { LogFn } from './logger.ts';
import type { MutationOrchestrator } from './mutation-orchestrator.ts';
import { computeChangeScope, changedAgainstHead } from './change-scope.ts';
import { validateFilesForProfile, SUPPORTED_EXTENSIONS } from './invariants.ts';
import {
  isOpenLoopRun,
  findTask,
  removeActiveTaskContext,
  setGateStatus,
  upsertActiveTaskContext,
} from '../session/helpers.ts';
import type {
  ActiveOperation,
  LoopRun,
  MutationTask,
  WorkflowSession,
} from '../session/session-schema.ts';
import {
  firstNestedStageId,
  nestedStages,
  type StageDef,
  type TransitionDef,
} from '../schema/types.ts';
import { matchesScope } from './scope-match.ts';
import { resolve, relative, isAbsolute } from 'node:path';
import type { TaskToolArgs } from './tool-args.ts';
import { existsSync } from 'node:fs';

const DEFAULT_TASK_RETRY_MAXIMUM = 3;
const RETRY_EXHAUSTED_DECISION_KIND = 'retry_exhausted';

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

interface SettlerDependencies {
  resolveEngine: (profileId: string, schemaId: string) => Promise<SessionGuardEngine>;
  log: LogFn;
  load?: (sessionId: string) => Promise<WorkflowSession | null>;
  save?: (session: WorkflowSession) => Promise<void>;
}

type GateOwner =
  | { kind: 'run'; run: LoopRun; loopStage: StageDef; stage: StageDef | undefined }
  | { kind: 'stage'; stageId: string; stage: StageDef }
  | { kind: 'refused'; stageLabel: string; declaredGates: string[] };

export class WorkflowResultSettlerImpl implements WorkflowResultSettler {
  private readonly resolveEngine: SettlerDependencies['resolveEngine'];
  private readonly log: LogFn;

  constructor(dependencies: SettlerDependencies | MutationOrchestrator, log?: LogFn) {
    if ('resolveEngine' in dependencies && log === undefined) {
      this.resolveEngine = dependencies.resolveEngine.bind(dependencies);
      this.log = async () => undefined;
      return;
    }
    this.resolveEngine = (dependencies as MutationOrchestrator).resolveEngine.bind(dependencies);
    this.log = log ?? (async () => undefined);
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

    // 1b. Workflow result — parse and record <workflow-result> tags (only for task tools)
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
    const reportingAgent = this.dispatchedAgent(args);
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
      if (session.processedResultCallIDs.length > 500) {
        session.processedResultCallIDs.splice(0, session.processedResultCallIDs.length - 500);
      }
    }

    const operation = session.activeOperations[callID];
    const provenance = session.verdictProvenance?.[callID];
    const stampedRunId = provenance?.runId ?? operation?.runId;
    const stampedRound = provenance?.round ?? operation?.round;
    if (stampedRunId !== undefined && stampedRound !== undefined) {
      const stamped = session.loopRuns[stampedRunId];
      if (stamped && (!isOpenLoopRun(stamped) || stampedRound !== stamped.round)) {
        output.output +=
          `\n\n[workflow-result-stale]\n` +
          `This result was produced for an earlier round of ${stamped.taskId}, ` +
          `which has since moved to ${stamped.stage}. Nothing was recorded.`;
        void this.log('warn', 'Workflow result from a finished round', {
          sessionID: session.sessionId,
          taskId: stamped.taskId,
          resultRound: stampedRound,
          currentRound: stamped.round,
        });
        this.releaseVerdict(session, callID);
        return;
      }
    }

    if (!parsed) {
      const silent = this.runForCall(session, provenance, operation);
      if (silent) {
        output.output +=
          `\n\n[workflow-result-missing]\n` +
          `Stage ${silent.stage} of ${silent.taskId} ended without a ` +
          `<workflow-result> marker, so nothing was recorded and the task did not move.`;
      }
      this.releaseVerdict(session, callID);
      return;
    }

    const owner = await this.resolveGateOwner(session, parsed.gate, provenance, operation);
    if (owner.kind === 'refused') {
      output.output +=
        `\n\n[workflow-result-rejected]\n` +
        (owner.declaredGates.length > 0
          ? `${owner.stageLabel} is waiting on [${owner.declaredGates.join(', ')}], ` +
            `and this result reports '${parsed.gate}'. Nothing was recorded.`
          : `No stage in scope declares the gate '${parsed.gate}'. Nothing was recorded.`);
      this.releaseVerdict(session, callID);
      return;
    }
    if (owner.kind === 'stage') {
      await this.recordStageGate(session, owner, parsed, reportingAgent, output);
      this.releaseVerdict(session, callID);
      return;
    }

    const { run, loopStage, stage: currentStage } = owner;
    const task = findTask(session, run.taskId);
    const declaredGates = currentStage?.gates ?? [];
    const mayMove = operation === undefined || operation.status === 'running';
    if (operation?.checks) run.checks = operation.checks;

    if (task && declaredGates.length > 0) {
      if (!this.mayVerify(reportingAgent, currentStage, session.profileId)) {
        output.output +=
          `\n\n[workflow-result-rejected]\n` +
          `Stage ${run.stage} accepts results from ` +
          `[${(currentStage?.allowedAgents ?? []).join(', ') || '(no roster)'}], ` +
          `and this one came from '${reportingAgent ?? '(unknown agent)'}'. Nothing was recorded.`;
        delete session.activeOperations[callID];
        return;
      }
      if (!declaredGates.includes(parsed.gate)) {
        output.output +=
          `\n\n[workflow-result-rejected]\n` +
          `Stage ${run.stage} is waiting on [${declaredGates.join(', ')}], ` +
          `and this result reports '${parsed.gate}'. Nothing was recorded.`;
        delete session.activeOperations[callID];
        return;
      }
      run.gates[parsed.gate] = parsed.status === 'pass' ? 'passed' : 'failed';
      session.verifications.push({
        gate: parsed.gate,
        status: parsed.status === 'pass' ? 'confirmed' : 'rejected',
        recordedAt: new Date().toISOString(),
      });

      const failed = declaredGates.some((gate) => run.gates[gate] === 'failed');
      const passed = declaredGates.every((gate) => run.gates[gate] === 'passed');
      if (mayMove && (failed || passed))
        await this.moveTask(session, run, task, loopStage, passed, failed, output);
    } else if (task) {
      session.verifications.push({
        gate: parsed.gate,
        status: parsed.status === 'pass' ? 'confirmed' : 'rejected',
        recordedAt: new Date().toISOString(),
      });
      if (mayMove && (parsed.status === 'pass' || parsed.status === 'fail')) {
        await this.moveTask(
          session,
          run,
          task,
          loopStage,
          parsed.status === 'pass',
          parsed.status === 'fail',
          output
        );
      }
    }
    this.releaseVerdict(session, callID);
  }

  private async moveTask(
    session: WorkflowSession,
    run: LoopRun,
    task: MutationTask,
    loopStage: StageDef,
    passed: boolean,
    failed: boolean,
    output: { output: string }
  ): Promise<void> {
    const engine = await this.resolveEngine(session.profileId, session.schemaId);
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
      return;
    }
    if (movement.kind === 'move') {
      const spendsBudget =
        failed || (movement.effects ?? []).some((effect) => effect.bumpRetry !== undefined);
      const exhausted = spendsBudget
        ? this.applyTaskEffects(session, task, loopStage, movement.effects, failed)
        : false;
      run.stage = movement.to;
      run.gates = {};
      run.round += 1;
      this.clearRunProvenance(session, run.id);
      if (exhausted) {
        run.status = 'awaiting_decision';
        this.upsertActiveTaskContextFromSession(session, run.id, 'awaiting_decision');
        this.upsertPendingDecision(session, task.id, run.id);
      } else {
        task.status = 'running';
        run.status = 'running';
        this.upsertActiveTaskContextFromSession(session, run.id, 'running');
      }
      return;
    }
    if (failed && movement.kind === 'unreachable')
      this.recordTaskRetryFailure(session, run, task, loopStage);
    if (movement.kind === 'blocked' || (passed && movement.kind === 'unreachable')) {
      output.output += `\n\n[workflow-task-${movement.kind}]\n${task.id} stayed at ${run.stage}: ${movement.reason}`;
    }
  }

  private async resolveGateOwner(
    session: WorkflowSession,
    gate: string,
    provenance: { runId?: string; round?: number } | undefined,
    operation: ActiveOperation | undefined
  ): Promise<GateOwner> {
    const runId = provenance?.runId ?? operation?.runId;
    if (runId !== undefined) {
      const run = session.loopRuns[runId];
      if (run && isOpenLoopRun(run)) {
        try {
          const loopStage = await this.resolveEngine(session.profileId, session.schemaId).then(
            (engine) => engine.getLoopStage(run.listKey)
          );
          if (loopStage) {
            const stage = nestedStages(loopStage).find((entry) => entry.id === run.stage);
            const declaredGates = stage?.gates ?? [];
            if (declaredGates.length === 0 || declaredGates.includes(gate))
              return { kind: 'run', run, loopStage, stage };
            return { kind: 'refused', stageLabel: run.stage, declaredGates };
          }
        } catch (error) {
          void this.log('warn', 'resolveGateOwner: loop stage could not be resolved', {
            error: String(error),
          });
        }
      }
    }
    const stageId = session.currentStage;
    if (!stageId) return { kind: 'refused', stageLabel: '(no stage)', declaredGates: [] };
    try {
      const stage = (await this.resolveEngine(session.profileId, session.schemaId)).getStages()[
        stageId
      ];
      const declaredGates = stage?.gates ?? [];
      return stage && declaredGates.includes(gate)
        ? { kind: 'stage', stageId, stage }
        : { kind: 'refused', stageLabel: stageId, declaredGates };
    } catch {
      return { kind: 'refused', stageLabel: stageId, declaredGates: [] };
    }
  }

  private async recordStageGate(
    session: WorkflowSession,
    owner: Extract<GateOwner, { kind: 'stage' }>,
    parsed: { gate: string; status: 'pass' | 'fail' },
    agent: string | undefined,
    output: { output: string }
  ): Promise<void> {
    if (!this.mayVerify(agent, owner.stage, session.profileId)) {
      output.output += `\n\n[workflow-result-rejected]\nStage ${owner.stageId} accepts results from [${(owner.stage.allowedAgents ?? []).join(', ') || '(no roster)'}], and this one came from '${agent ?? '(unknown agent)'}'. Nothing was recorded.`;
      return;
    }
    setGateStatus(
      session,
      parsed.gate,
      parsed.status === 'pass' ? 'passed' : 'failed',
      undefined,
      new Date().toISOString()
    );
  }

  private applyApprovalEffects(
    session: WorkflowSession,
    run: LoopRun,
    to: string,
    effects: TransitionDef['effects']
  ): void {
    for (const effect of effects ?? [])
      if (effect.approve)
        approve(
          session,
          effect.approve,
          '',
          `transition:${run.stage}->${to}`,
          new Date().toISOString()
        );
  }

  private applyTaskEffects(
    session: WorkflowSession,
    task: MutationTask,
    stage: StageDef | null,
    effects: TransitionDef['effects'],
    spendOnFailure = false
  ): boolean {
    const declared = (effects ?? []).filter((effect) => effect.bumpRetry !== undefined);
    if (declared.length === 0 && spendOnFailure)
      return this.spendTaskAttempt(session, task, stage, undefined);
    let exhausted = false;
    for (const effect of declared)
      if (
        effect.bumpRetry === 'task.id' &&
        this.spendTaskAttempt(session, task, stage, effect.maxAttempts)
      )
        exhausted = true;
    return exhausted;
  }

  private spendTaskAttempt(
    session: WorkflowSession,
    task: MutationTask,
    stage: StageDef | null,
    maximum: number | undefined
  ): boolean {
    const budget = session.retryBudgets[task.id] ?? {
      attempts: 0,
      maximum: maximum ?? stage?.retryBudget?.maximum ?? DEFAULT_TASK_RETRY_MAXIMUM,
    };
    if (maximum !== undefined) budget.maximum = maximum;
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
    const budget = session.retryBudgets[task.id] ?? {
      attempts: 0,
      maximum: stage?.retryBudget?.maximum ?? DEFAULT_TASK_RETRY_MAXIMUM,
    };
    budget.attempts += 1;
    session.retryBudgets[task.id] = budget;
    task.status = 'running';
    run.stage = firstNestedStageId(stage) ?? run.stage;
    run.gates = {};
    run.round += 1;
    this.clearRunProvenance(session, run.id);
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
    const pending = (session.pendingDecisions ??= []);
    if (
      pending.some(
        (decision) =>
          decision.subject === 'task' &&
          decision.subjectId === taskId &&
          decision.kind === RETRY_EXHAUSTED_DECISION_KIND &&
          decision.status === 'pending'
      )
    )
      return;
    pending.push({
      id: `${taskId}:${RETRY_EXHAUSTED_DECISION_KIND}`,
      subject: 'task',
      subjectId: taskId,
      runId,
      kind: RETRY_EXHAUSTED_DECISION_KIND,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  private upsertActiveTaskContextFromSession(
    session: WorkflowSession,
    runId: string,
    status: 'running' | 'awaiting_decision'
  ): void {
    const existing = session.activeTaskContexts.find((context) => context.runId === runId);
    upsertActiveTaskContext(
      session,
      { runId, taskId: existing?.taskId ?? '', agent: existing?.agent ?? '', status },
      new Date().toISOString()
    );
  }

  private clearRunProvenance(session: WorkflowSession, runId: string): void {
    for (const callId of Object.keys(session.verdictProvenance ?? {}))
      if (session.verdictProvenance[callId]?.runId === runId)
        delete session.verdictProvenance[callId];
  }

  private releaseVerdict(session: WorkflowSession, callID: string): void {
    delete session.activeOperations[callID];
    if (session.verdictProvenance) delete session.verdictProvenance[callID];
  }

  private runForCall(
    session: WorkflowSession,
    provenance: { runId?: string; round?: number } | undefined,
    operation: ActiveOperation | undefined
  ): LoopRun | undefined {
    const run = session.loopRuns[provenance?.runId ?? operation?.runId ?? ''];
    return run && isOpenLoopRun(run) ? run : undefined;
  }

  private dispatchedAgent(args: unknown): string | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const taskArgs = args as TaskToolArgs;
    return taskArgs.subagent_type ?? taskArgs.agent ?? taskArgs.type;
  }

  private mayVerify(
    agent: string | undefined,
    stage: { allowedAgents?: string[] } | undefined,
    profileId: string
  ): boolean {
    if (!agent) return false;
    const roster = stage?.allowedAgents ?? [];
    return roster.length === 0 || agentIsAllowed(agent, roster, profileId);
  }
}
