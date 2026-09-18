import { spawnSync } from 'node:child_process';
import type { WorkflowSession } from '../session/session-schema.ts';
import type { WorkflowStore } from '../session/session-store.ts';
import type { MutationOrchestrator } from './mutation-orchestrator.ts';
import type { SessionExecutor, SessionTransaction } from './session-executor.ts';
import type { LogFn } from './logger.ts';
import { getCurrentHead } from './git-utils.ts';

export interface LifecycleEventInput {
  event: {
    type: string;
    part?: LifecycleEventPart;
    properties?: { part?: LifecycleEventPart; sessionID?: unknown } & Record<string, unknown>;
  };
}

interface LifecycleEventPart {
  id?: string;
  callID?: string;
  status?: string;
  state?: { status?: string };
}

interface TransitionResult {
  applied: boolean;
  from?: string;
  to?: string;
  guard?: string | null;
}

export interface WorkflowLifecycleDependencies {
  store: Pick<WorkflowStore, 'archive' | 'list' | 'load'>;
  executor: Pick<SessionExecutor, 'run'>;
  mutationOrchestrator: Pick<
    MutationOrchestrator,
    'applyTransitions' | 'clearOnError' | 'dispose' | 'resolveEngine'
  >;
  log: LogFn;
  projectDir: string;
}

export interface WorkflowLifecycle {
  afterTool(
    session: WorkflowSession,
    transaction: Pick<SessionTransaction, 'deferAfterSave'>
  ): Promise<void>;
  handleEvent(input: LifecycleEventInput): Promise<void>;
  handleCommitTaskAfter(
    session: WorkflowSession,
    callID: string,
    output: { output: string }
  ): Promise<void>;
  dispose(): void;
}

export function createWorkflowLifecycle(
  dependencies: WorkflowLifecycleDependencies
): WorkflowLifecycle {
  const { projectDir, store, executor, mutationOrchestrator, log } = dependencies;

  const recordOutcomeIfFinished = async (
    session: WorkflowSession,
    moved: TransitionResult
  ): Promise<void> => {
    if (!moved.to) return;

    let engine: Awaited<ReturnType<MutationOrchestrator['resolveEngine']>>;
    try {
      engine = await mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
    } catch {
      return;
    }
    if (!engine.isTerminalStage(moved.to)) return;

    session.outcome = {
      stage: moved.to,
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
    void log('info', 'Workflow finished', {
      sessionID: session.sessionId,
      stage: moved.to,
      from: session.outcome.from,
      guard: session.outcome.guard,
      failedGates: session.outcome.failedGates,
      exhaustedBudgets: session.outcome.exhaustedBudgets,
    });
  };

  const archiveIfFinished = async (session: WorkflowSession): Promise<void> => {
    let engine: Awaited<ReturnType<MutationOrchestrator['resolveEngine']>>;
    try {
      engine = await mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
    } catch {
      return;
    }
    if (!engine.isTerminalStage(session.currentStage)) return;

    const archived = await store.archive(session.sessionId);
    if (archived) {
      void log('info', 'Workflow finished: session archived', {
        sessionID: session.sessionId,
        stage: session.currentStage,
        path: archived,
      });
    }
  };

  const afterTool = async (
    session: WorkflowSession,
    transaction: Pick<SessionTransaction, 'deferAfterSave'>
  ): Promise<void> => {
    try {
      const moved = await mutationOrchestrator.applyTransitions(session);
      if (!moved.applied) return;
      await recordOutcomeIfFinished(session, moved);
      transaction.deferAfterSave(() => archiveIfFinished(session));
    } catch (error) {
      void log('warn', 'transitionAfter: tryApplyTransitions failed', {
        sessionID: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const eventPart = (input: LifecycleEventInput): LifecycleEventPart | undefined =>
    input.event.properties?.part ?? input.event.part;

  const handleEvent = async (input: LifecycleEventInput): Promise<void> => {
    const part = eventPart(input);
    const isError =
      input.event.type === 'message.part.updated' &&
      (part?.state?.status === 'error' || part?.status === 'failed');
    if (!isError) return;

    const callID = part?.callID ?? part?.id;
    if (!callID) return;

    await mutationOrchestrator.clearOnError(callID);
    const sessionIDs = await store.list();
    for (const sessionID of sessionIDs) {
      try {
        const loaded = await store.load(sessionID);
        const operation = loaded?.activeOperations[callID];
        if (!operation || operation.status !== 'running') continue;
        await executor.run(sessionID, async (transaction) => {
          const current = transaction.session?.activeOperations[callID];
          if (!current || current.status !== 'running') return;
          current.status = 'interrupted';
          current.interruptedAt = new Date().toISOString();
        });
      } catch (error) {
        await log('warn', 'markTaskOperationInterrupted: session skipped', {
          sessionID,
          callID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const handleCommitTaskAfter = async (
    session: WorkflowSession,
    callID: string,
    output: { output: string }
  ): Promise<void> => {
    if (!session.deliveryPermit) return;
    if (session.deliveryPermit.callID !== callID) return;

    const currentHead = getCurrentHead(projectDir);
    if (currentHead === session.deliveryPermit.preCommitHead || currentHead === 'unknown') {
      return;
    }

    let committed: string[] | null = null;
    try {
      const result = spawnSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', currentHead],
        {
          cwd: projectDir,
          encoding: 'utf-8',
          timeout: 5000,
        }
      );
      if (result.status === 0) {
        committed = (result.stdout ?? '').split('\n').filter(Boolean).sort();
      }
    } catch {
      void log('warn', 'handleCommitTaskAfter: git diff-tree failed', {
        sessionID: session.sessionId,
      });
    }

    const expected = [...(session.deliveryPermit.expectedFiles ?? [])].sort();
    const reject = (reason: string, extra: Record<string, unknown>): void => {
      session.deliveryPermit = null;
      output.output += `\n\n[workflow-commit-rejected]\n${reason}\nThe commit ${currentHead} stands in git, but no delivery receipt was recorded: the workflow stays in \`commit\`. Reconcile the worktree and run the commit step again.`;
      void log('warn', `handleCommitTaskAfter: ${reason}`, {
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
    void log('info', `Commit detected: ${currentHead}`, {
      sessionID: session.sessionId,
      callID,
      fileCount: committed.length,
    });
  };

  return {
    afterTool,
    handleEvent,
    handleCommitTaskAfter,
    dispose: () => mutationOrchestrator.dispose(),
  };
}
