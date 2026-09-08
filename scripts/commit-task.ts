#!/usr/bin/env bun
/**
 * commit-task.ts — the committing step of the workflow.
 *
 * The plugin recognises this call from the schema: the acting stage declares a
 * `bash` action with `delivers: true`, and its `commands:` name this script.
 * A stage that declares nothing falls back to recognition by file name
 * (`isCommitTaskCommand`). The plugin then wraps the call:
 *
 *   1. `handleCommitTaskBefore` records a `deliveryPermit` holding the
 *      pre-commit HEAD and the files the session expects to land. Whether the
 *      call is allowed at all is the delivering entry's own `guard:` — in
 *      `base` that is every task completed and both verdicts collected.
 *   2. This script performs the commit.
 *   3. `handleCommitTaskAfter` re-reads HEAD; only when it actually moved does
 *      it write `deliveryReceipt`, which is what releases `commit → done`.
 *
 * So a failed commit leaves HEAD untouched, no receipt is written, and the
 * workflow correctly stays in `commit`.
 *
 * Usage:
 *   bun run scripts/commit-task.ts -m "feat: message"
 *   bun run scripts/commit-task.ts -m "fix: message" src/a.ts src/b.ts
 *
 * Without explicit paths every change in the worktree is staged.
 */
import { spawnSync } from 'node:child_process';

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { encoding: 'utf-8', timeout: 30_000 });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function fail(message: string): never {
  console.error(`commit-task: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const messageIndex = argv.findIndex((arg) => arg === '-m' || arg === '--message');
if (messageIndex === -1 || !argv[messageIndex + 1]) {
  fail('a commit message is required: commit-task.ts -m "<message>"');
}
const message = argv[messageIndex + 1];
const paths = argv.filter((_, i) => i !== messageIndex && i !== messageIndex + 1);

if (git(['rev-parse', '--git-dir']).status !== 0) {
  fail('not inside a git repository');
}

const staged = paths.length > 0 ? git(['add', '--', ...paths]) : git(['add', '-A']);
if (staged.status !== 0) {
  fail(`git add failed: ${staged.stderr}`);
}

// Nothing staged means committing would either fail or create an empty commit.
// Either way HEAD must not move: the plugin reads HEAD to decide whether the
// step succeeded, and an empty commit would forge that proof.
if (git(['diff', '--cached', '--quiet']).status === 0) {
  fail('nothing staged to commit');
}

const commit = git(['commit', '-m', message]);
if (commit.status !== 0) {
  fail(`git commit failed: ${commit.stderr || commit.stdout}`);
}

const head = git(['rev-parse', 'HEAD']);
// `--root` is what makes the repository's first commit answerable: diff-tree
// compares against a parent, and the initial commit has none, so without it
// this prints nothing and the commit looks empty.
const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', head.stdout]);
console.log(`commit-task: committed ${head.stdout}`);
for (const file of files.stdout.split('\n').filter(Boolean)) {
  console.log(`  ${file}`);
}
