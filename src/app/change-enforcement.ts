import { isAbsolute, relative, resolve, join, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  extractBashCommand,
  hasForbiddenGitSubcommand,
  isReadOnlyBashCommand,
} from '../domain/session-queries.ts';
import { getCurrentHead } from './git-utils.ts';
import { matchesScope } from './scope-match.ts';
import { extractToolCallPaths } from '../rules/message-paths.ts';
import { parsePatch } from '../rules/file-observation.ts';
import { changedAgainstHead } from './change-scope.ts';
import type { WorkflowSession, MutationTask } from '../session/session-schema.ts';
import { findTask, isOpenLoopRun } from '../session/helpers.ts';
import { toGuardContext, type SessionGuardEngine } from '../domain/engine.ts';
import { admitAction, commandMatches, type AdmissionRequest } from '../domain/action-admission.ts';
import type { ActionEntry } from '../schema/profile-schema.ts';
import { nestedStages } from '../schema/types.ts';
import type { MutationOrchestrator } from './mutation-orchestrator.ts';
import type { SessionExecutor } from './session-executor.ts';
import type { LogFn } from './logger.ts';
import { type Reporter } from './report.ts';
import type { ApplyPatchToolArgs } from './tool-args.ts';

export interface ChangeBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  output: { args: unknown };
  session: WorkflowSession;
}

export interface ChangeAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  output: { title: string; output: string; metadata: unknown };
  session: WorkflowSession;
}

export interface ChangeEnforcement {
  before(input: ChangeBeforeInput): Promise<void>;
  after(input: ChangeAfterInput): Promise<void>;
}

export interface ChangeEnforcementPorts {
  mutationOrchestrator: MutationOrchestrator;
  executor: SessionExecutor;
  projectDir: string;
  profilesDir: string;
  log: LogFn;
  report: Reporter;
  fileTools: Set<string>;
  mutatingTools: Set<string>;
  readTools: Set<string>;
}

export function canonicalProjectPath(projectDir: string, path: string): string | null {
  const root = resolve(projectDir);
  const absolute = resolve(root, path);
  const result = relative(root, absolute);
  if (isAbsolute(result) || result.startsWith('..')) return null;
  return result;
}

export function isReadOnlyBash(command: string): boolean {
  return isReadOnlyBashCommand(command);
}

export function createChangeEnforcement(ports: ChangeEnforcementPorts): ChangeEnforcement {
  const { mutationOrchestrator, executor, projectDir, log, fileTools, mutatingTools, readTools } =
    ports;

  // ─── Helper methods ───

  function actingStageActions(session: WorkflowSession): Promise<ActionEntry[] | undefined> {
    return (async () => {
      let engine: SessionGuardEngine;
      try {
        engine = await mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
      } catch {
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

      if (outer.loop) {
        const first = nestedStages(outer)[0];
        if (first?.actions) return first.actions;
      }
      return outer.actions;
    })();
  }

  function forbiddenGitDefault(tool: string, callID: string, args: unknown): void {
    if (tool !== 'bash') return;
    const command = extractBashCommand(args);
    if (!hasForbiddenGitSubcommand(command)) return;
    void log('warn', `Blocked forbidden git command`, { callID, command });
    throw new Error(
      'Direct git commit/push is blocked. Declare a delivery action with delivers: true.'
    );
  }

  function scopeTargetPaths(tool: string, args: unknown): string[] {
    if (tool === 'apply_patch') {
      const patchText = (args as ApplyPatchToolArgs).patchText;
      if (typeof patchText !== 'string') return [];
      const parsed = parsePatch(patchText);
      return parsed ? parsed.map((observation) => observation.path) : [];
    }
    return extractToolCallPaths(tool, args);
  }

  function realPathOf(path: string): string {
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

  function toProjectRelativePath(path: string): string | null {
    const root = realPathOf(projectDir);
    const absolute = realPathOf(isAbsolute(path) ? path : resolve(projectDir, path));
    const rel = relative(root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel;
  }

  async function declaredDeliveryCommands(sessionID: string): Promise<string[]> {
    const session = await executor.run(sessionID, async (tx) => tx.session ?? null);
    if (!session) return [];
    const actions = await actingStageActions(session);
    if (!actions) return [];
    return actions
      .filter((entry) => entry.delivers && entry.commands)
      .flatMap((entry) => entry.commands ?? []);
  }

  async function isCommitDelivery(
    tool: string,
    sessionID: string,
    args: unknown
  ): Promise<boolean> {
    if (tool !== 'bash') return false;
    const command = extractBashCommand(args);
    const declared = await declaredDeliveryCommands(sessionID);
    return declared.length > 0 && commandMatches(command, declared);
  }

  function isReadOnlyBashCheck(tool: string, args: unknown): boolean {
    return tool === 'bash' && isReadOnlyBashCommand(extractBashCommand(args));
  }

  function activeRunningTasks(session: WorkflowSession): MutationTask[] {
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

  // ─── Core enforcement methods ───

  async function scopeBefore(tool: string, session: WorkflowSession, args: unknown): Promise<void> {
    const isWrite = fileTools.has(tool);
    const isRead = readTools.has(tool);
    if (!isWrite && !isRead) return;

    const activeTasks = activeRunningTasks(session);
    if (activeTasks.length === 0) return;

    for (const rawPath of scopeTargetPaths(tool, args)) {
      const relPath = toProjectRelativePath(rawPath);
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
          throw new Error(
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
            throw new Error(
              `${tool} refused: '${named}' is outside every active task's readScope (${scopes})`
            );
          }
        }
      }
    }
  }

  async function actionsBefore(
    tool: string,
    session: WorkflowSession,
    callID: string,
    args: unknown
  ): Promise<void> {
    let request: AdmissionRequest | null = null;
    if (tool === 'bash') {
      request = { action: 'bash', command: extractBashCommand(args) };
    } else if (fileTools.has(tool)) {
      request = { action: 'edit', paths: scopeTargetPaths(tool, args) };
    }
    if (!request) return;

    const actions = await actingStageActions(session);
    if (actions === undefined) {
      forbiddenGitDefault(tool, callID, args);
      return;
    }

    const engine = await mutationOrchestrator.resolveEngine(session.profileId, session.schemaId);
    const facts = toGuardContext(session);
    const verdict = admitAction(actions, request, (expression) =>
      engine.evaluateGuard(expression, facts)
    );
    if (!verdict.allowed) {
      void log('warn', 'Action refused by the stage', {
        sessionID: session.sessionId,
        tool,
        reason: verdict.reason,
      });
      throw new Error(verdict.reason ?? 'Action refused by the stage');
    }
  }

  async function commitBefore(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown
  ): Promise<void> {
    if (await isCommitDelivery(tool, sessionID, args)) {
      const session = await executor.run(sessionID, async (tx) => tx.session ?? null);
      if (!session) return;

      const preCommitHead = getCurrentHead(projectDir);
      session.deliveryPermit = {
        callID,
        preCommitHead,
        expectedFiles: changedAgainstHead(projectDir).filter((file) =>
          session.changedFiles.includes(file)
        ),
        startedAt: new Date().toISOString(),
      };
      // Save via executor to maintain transactional semantics
      await executor.run(sessionID, async (tx) => {
        if (tx.session) {
          // The session is already the same object, just persist
        }
      });
      void log('info', `Issued deliveryPermit for commit`, { callID, preCommitHead, sessionID });
    }
  }

  async function mutationBefore(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { args: unknown }
  ): Promise<void> {
    if (!mutatingTools.has(tool)) return;
    if (await isCommitDelivery(tool, sessionID, args)) return;
    if (isReadOnlyBashCheck(tool, args)) return;
    await mutationOrchestrator.beginMutation({ sessionID, callID }, output);
  }

  async function mutationAfter(
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    if (!mutatingTools.has(tool)) return;
    if (await isCommitDelivery(tool, sessionID, args)) return;
    if (isReadOnlyBashCheck(tool, args)) return;
    await mutationOrchestrator.finishMutation(
      { sessionID, callID, metadata: output.metadata },
      (text) => {
        output.output += text;
      }
    );
  }

  return {
    async before(input) {
      await scopeBefore(input.tool, input.session, input.args);
      await actionsBefore(input.tool, input.session, input.callID, input.args);
      await commitBefore(input.tool, input.sessionID, input.callID, input.args);
      await mutationBefore(input.tool, input.sessionID, input.callID, input.args, input.output);
    },
    async after(input) {
      await mutationAfter(input.tool, input.sessionID, input.callID, input.args, input.output);
    },
  };
}

export { extractBashCommand };
