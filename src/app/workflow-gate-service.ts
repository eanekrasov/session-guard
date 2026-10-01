import { approve } from '../domain/approvals.ts';
import { toGuardContext, type SessionGuardEngine } from '../domain/engine.ts';
import { nextTaskStage, TASK_DONE } from '../domain/task-movement.ts';
import { agentIsAllowed } from './agent-names.ts';
import type { LogFn } from './logger.ts';
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

const DEFAULT_TASK_RETRY_MAXIMUM = 3;
const RETRY_EXHAUSTED_DECISION_KIND = 'retry_exhausted';

// ─── Public result types ─────────────────────────────────────────────────

export type GateApplicationResult =
  | { kind: 'recorded'; verdict: GateVerdictDetail }
  | { kind: 'replayed'; reason: string }
  | { kind: 'stale'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'missing-session' };

export interface GateVerdictDetail {
  gate: string;
  status: 'passed' | 'failed';
  stage: string;
  moved?: { to: string; passed: boolean; failed: boolean };
}

// ─── Internal types ───────────────────────────────────────────────────────

export interface GateServiceDependencies {
  resolveEngine: (profileId: string, schemaId: string) => Promise<SessionGuardEngine>;
  log: LogFn;
}

type GateOwner =
  | { kind: 'run'; run: LoopRun; loopStage: StageDef; stage: StageDef | undefined }
  | { kind: 'stage'; stageId: string; stage: StageDef }
  | { kind: 'refused'; stageLabel: string; declaredGates: string[] };

// ─── Service ──────────────────────────────────────────────────────────────

export class WorkflowGateService {
  private readonly resolveEngine: GateServiceDependencies['resolveEngine'];
  private readonly log: LogFn;

  constructor(deps: GateServiceDependencies) {
    this.resolveEngine = deps.resolveEngine;
    this.log = deps.log;
  }

  /**
   * Record a gate verdict from a direct tool call (no workflow-result marker).
   * The caller is responsible for persisting the session.
   */
  async applyGate(input: {
    session: WorkflowSession;
    gate: string;
    status: 'pass' | 'fail';
    reportingAgent?: string;
    callID?: string;
    operation?: ActiveOperation;
  }): Promise<GateApplicationResult> {
    const { session, gate, status, reportingAgent, callID, operation } = input;
    const provenance = callID ? session.verdictProvenance?.[callID] : undefined;

    // Prevent replay within the same callID
    if (callID && (session.processedResultCallIDs ?? []).includes(callID)) {
      return {
        kind: 'replayed',
        reason: `The result for ${callID} has already been recorded.`,
      };
    }

    // Check stale round
    const stampedRunId = provenance?.runId ?? operation?.runId;
    const stampedRound = provenance?.round ?? operation?.round;
    if (stampedRunId !== undefined && stampedRound !== undefined) {
      const stamped = session.loopRuns[stampedRunId];
      if (stamped && (!isOpenLoopRun(stamped) || stampedRound !== stamped.round)) {
        return {
          kind: 'stale',
          reason: `Result produced for an earlier round of ${stamped.taskId} (round ${stampedRound}, current ${stamped.round}).`,
        };
      }
    }

    // Mark processed
    if (callID) {
      session.processedResultCallIDs ??= [];
      session.processedResultCallIDs.push(callID);
      if (session.processedResultCallIDs.length > 500) {
        session.processedResultCallIDs.splice(0, session.processedResultCallIDs.length - 500);
      }
    }

    // Resolve gate owner
    const owner = await this.resolveGateOwner(session, gate, provenance, operation);
    if (owner.kind === 'refused') {
      return {
        kind: 'rejected',
        reason:
          owner.declaredGates.length > 0
            ? `${owner.stageLabel} is waiting on [${owner.declaredGates.join(', ')}], ` +
              `and this result reports '${gate}'. Nothing was recorded.`
            : `No stage in scope declares the gate '${gate}'. Nothing was recorded.`,
      };
    }

    if (owner.kind === 'stage') {
      const rejected = !this.mayVerify(reportingAgent, owner.stage, session.profileId);
      if (!rejected) {
        setGateStatus(
          session,
          gate,
          status === 'pass' ? 'passed' : 'failed',
          undefined,
          new Date().toISOString()
        );
      }
      return {
        kind: 'recorded',
        verdict: {
          gate,
          status: status === 'pass' ? 'passed' : 'failed',
          stage: owner.stageId,
        },
      };
    }

    // Loop-run owner
    const { run, loopStage, stage: currentStage } = owner;
    const task = findTask(session, run.taskId);
    const declaredGates = currentStage?.gates ?? [];
    const mayMove = operation === undefined || operation.status === 'running';

    if (operation?.checks) run.checks = operation.checks;

    if (task && declaredGates.length > 0) {
      if (!this.mayVerify(reportingAgent, currentStage, session.profileId)) {
        // Tool caller is not allowed — produces a recorded verdict
        // but the gate itself is silently refused
        return {
          kind: 'rejected',
          reason:
            `Stage ${run.stage} accepts results from ` +
            `[${(currentStage?.allowedAgents ?? []).join(', ') || '(no roster)'}], ` +
            `and this one came from '${reportingAgent ?? '(unknown agent)'}'.`,
        };
      }
      if (!declaredGates.includes(gate)) {
        return {
          kind: 'rejected',
          reason:
            `Stage ${run.stage} is waiting on [${declaredGates.join(', ')}], ` +
            `and this result reports '${gate}'.`,
        };
      }

      run.gates[gate] = status === 'pass' ? 'passed' : 'failed';
      session.verifications.push({
        gate,
        status: status === 'pass' ? 'confirmed' : 'rejected',
        recordedAt: new Date().toISOString(),
      });

      const failed = declaredGates.some((g) => run.gates[g] === 'failed');
      const passed = declaredGates.every((g) => run.gates[g] === 'passed');

      const detail: GateVerdictDetail = {
        gate,
        status: status === 'pass' ? 'passed' : 'failed',
        stage: run.stage,
      };

      if (mayMove && (failed || passed)) {
        const moved = await this.moveTask(session, run, task, loopStage, passed, failed);
        if (moved) detail.moved = moved;
      }

      return { kind: 'recorded', verdict: detail };
    }

    if (task) {
      session.verifications.push({
        gate,
        status: status === 'pass' ? 'confirmed' : 'rejected',
        recordedAt: new Date().toISOString(),
      });

      const detail: GateVerdictDetail = {
        gate,
        status: status === 'pass' ? 'passed' : 'failed',
        stage: run.stage,
      };

      if (mayMove && (status === 'pass' || status === 'fail')) {
        const moved = await this.moveTask(
          session,
          run,
          task,
          loopStage,
          status === 'pass',
          status === 'fail'
        );
        if (moved) detail.moved = moved;
      }

      return { kind: 'recorded', verdict: detail };
    }

    return {
      kind: 'recorded',
      verdict: { gate, status: status === 'pass' ? 'passed' : 'failed', stage: '' },
    };
  }

  // ─── Gate owner resolution ────────────────────────────────────────────

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

  // ─── Task movement ────────────────────────────────────────────────────

  private async moveTask(
    session: WorkflowSession,
    run: LoopRun,
    task: MutationTask,
    loopStage: StageDef,
    passed: boolean,
    failed: boolean
  ): Promise<{ to: string; passed: boolean; failed: boolean } | undefined> {
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
      return { to: TASK_DONE, passed, failed };
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
      return { to: movement.to, passed, failed };
    }
    if (failed && movement.kind === 'unreachable')
      this.recordTaskRetryFailure(session, run, task, loopStage);
    return undefined;
  }

  // ─── Effects and budgets ──────────────────────────────────────────────

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

  // ─── Decision/context bookkeeping ─────────────────────────────────────

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

  // ─── Helpers ──────────────────────────────────────────────────────────

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
