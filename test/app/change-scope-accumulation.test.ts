import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processScopeAndInvariants } from '../../src/app/mutation-orchestrator.ts';
import { captureBaseline } from '../../src/app/change-scope.ts';
import { createSession } from '../../src/session/session-store.ts';
import { createTask } from '../support/task-factory.ts';
import { fixtureProfilesDir } from '../support/fixture-profiles.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

let repo: string;

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'scope-accum-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  await writeFile(join(repo, 'README.md'), 'seed\n', 'utf-8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function run(session: WorkflowSession, frame: Record<string, string | null>) {
  return processScopeAndInvariants({
    session,
    scopeRoot: repo,
    projectDir: repo,
    // A real profile directory: invariants that cannot be loaded now fail
    // closed rather than reporting a clean file, so a bogus path would make
    // every move fail for a reason this test is not about.
    profilesDir: fixtureProfilesDir('profiles'),
    metadataFailed: false,
    log: async () => {},
    frame,
  });
}

describe('the move being judged and the work being delivered are different lists', () => {
  it('accumulates changedFiles across moves for the delivery permit', async () => {
    // The permit is built from session.changedFiles, so it has to be
    // everything the work produced. Replacing it left the permit expecting
    // only the last move's files.
    const session = createSession('accum', 'base', 'state-machine', 'planning');

    await mkdir(join(repo, 'src'), { recursive: true });
    let frame = await captureBaseline(repo);
    await writeFile(join(repo, 'src/first.md'), 'one\n', 'utf-8');
    await run(session, frame);
    expect(session.changedFiles).toEqual(['src/first.md']);

    frame = await captureBaseline(repo);
    await writeFile(join(repo, 'src/second.md'), 'two\n', 'utf-8');
    await run(session, frame);
    expect(session.changedFiles).toEqual(['src/first.md', 'src/second.md']);
  });

  it('judges a move against its own scope, not everything before it', async () => {
    // Accumulating into the list that the writeScope check reads convicted a
    // move of what an earlier one did: files from a previous task, with a
    // different scope, counted as this task's violation. The host smoke run
    // showed it as 'invariants gate is failed' on three scenarios that had
    // been green.
    const session = createSession('scoped', 'base', 'state-machine', 'planning');
    session.tasks.implementation = [createTask({ id: 'task-1', writeScope: ['docs/**'] })];

    // An earlier move left a file outside what the current task may write.
    session.changedFiles = ['src/from-an-earlier-task.md'];

    session.activeOperations = {};
    await mkdir(join(repo, 'docs'), { recursive: true });
    const frame = await captureBaseline(repo);
    await writeFile(join(repo, 'docs/note.md'), 'in scope\n', 'utf-8');

    const result = await run(session, frame);

    expect(result.finalPassed).toBe(true);
    expect(session.changedFiles).toContain('src/from-an-earlier-task.md');
    expect(session.changedFiles).toContain('docs/note.md');
  });
});
