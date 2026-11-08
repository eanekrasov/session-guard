import type { LogFn } from './logger.ts';
import { computeChangeScope, changedAgainstHead } from './change-scope.ts';
import { validateFilesForProfile, SUPPORTED_EXTENSIONS } from './invariants.ts';
import { findTask, isOpenLoopRun } from '../session/helpers.ts';
import type { ActiveOperation, WorkflowSession } from '../session/session-schema.ts';
import { matchesScope } from './scope-match.ts';
import { resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

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

export class WorkflowResultSettlerImpl implements WorkflowResultSettler {
  private readonly log: LogFn;
  private readonly projectDir: string;
  private readonly profilesDir: string;

  constructor(log: LogFn, projectDir = '', profilesDir = '') {
    this.log = log;
    this.projectDir = projectDir;
    this.profilesDir = profilesDir;
  }

  async prepareTaskVerdict(session: WorkflowSession, operation: ActiveOperation): Promise<void> {
    if (operation.result === 'output_ready') return;
    await this.runTaskInvariants(
      session,
      operation.callId,
      this.projectDir,
      this.profilesDir,
      operation
    );
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

    // The gate tool runs invariants before applying its verdict. Calls without a
    // gate still settle here, so task completion never depends on response text.
    if (tool === 'task') {
      if (operation?.result !== 'output_ready')
        await this.runTaskInvariants(session, callID, projectDir, profilesDir, operation);
      delete session.activeOperations[callID];
      if (session.verdictProvenance) delete session.verdictProvenance[callID];
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
}
