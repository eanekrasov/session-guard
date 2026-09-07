import { getGate } from '../session/helpers.ts';
import type { WorkflowSession } from '../session/session-schema.ts';

/**
 * Extract the shell command from bash tool arguments.
 *
 * The host passes bash arguments as `{ command: "..." }`, so stringifying the
 * whole object hides the command behind JSON punctuation and defeats the
 * anchored patterns in `hasForbiddenGitSubcommand`. Unrecognised shapes fall
 * back to the serialised form so they are still scanned.
 */
export function extractBashCommand(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    const command = (args as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return JSON.stringify(args ?? '');
}

/**
 * Commands that cannot change the working tree, by name.
 *
 * An allowlist, not a denylist, and deliberately short. `bash` carries no path
 * argument, so a mutating command is governed only by the mutation lifecycle
 * and the frame diff that follows it — which means anything let through here
 * without that lifecycle is ungoverned. A name that is not on this list is
 * treated as a mutation, whatever it actually does.
 */
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'bat',
  'head',
  'tail',
  'wc',
  'ls',
  'eza',
  'tree',
  'pwd',
  'echo',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'date',
  'env',
  'rg',
  'grep',
  'fd',
  'find',
  'jq',
  'diff',
  'sort',
  'uniq',
  'basename',
  'dirname',
  'realpath',
  'true',
  'false',
]);

/** Read-only git subcommands. `git` alone proves nothing about the call. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'shortlog',
  'cat-file',
  'symbolic-ref',
  // `config` is deliberately absent: `git config user.name x` writes as
  // readily as `git config user.name` reads, and telling them apart lexically
  // is exactly the guess this classifier must not make.
]);

/**
 * Check if the session can commit: all required gates must pass, all tasks completed.
 */
export function canCommit(session: WorkflowSession, requiredGates: string[]): boolean {
  for (const gateId of requiredGates) {
    const gate = getGate(session, gateId);
    if (!gate) return false;
    if (gate.status !== 'passed') return false;
  }

  const tasks = Object.values(session.tasks ?? {}).flat();
  return tasks.every((t) => t.status === 'completed');
}

// ─── P1-012: Commit Permit helpers ────────────────────────────────────────────

/** Git subcommands a workflow session may not run directly. */
const FORBIDDEN_GIT_SUBCOMMANDS = new Set(['commit', 'push']);

/**
 * Git's own global options that consume the token after them.
 *
 * These sit between `git` and its subcommand, so a scan that stops at the
 * first word after `git` reads `.` or `user.name=x` as the subcommand and
 * finds nothing forbidden. `git -C . push` is `git push`.
 */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
]);

/**
 * Words that run another command and can therefore hide one.
 *
 * `sudo git push` and `env git push` are `git push`. Anything longer than this
 * — a shell wrapper, xargs, a script — is out of reach of a lexical check, and
 * pretending otherwise would be worse than saying so.
 */
const COMMAND_PREFIXES = new Set(['sudo', 'env', 'command', 'builtin', 'nice', 'time', 'exec']);

/** Where one command ends and the next begins, including substitutions. */
const SEGMENT_SEPARATORS = /[\n;&|()`]/;

/**
 * Split a shell command into words, honouring quotes and backslash escapes.
 *
 * Quotes are removed, so `"git" push` and `g''it push` both tokenise to the
 * words a shell would run. A separator outside quotes ends the segment, so
 * each returned array is one command.
 */
function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  const endWord = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index];
        started = true;
      } else {
        word += char;
        started = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      // An empty quoted string is still a word: `git "" push` has three.
      started = true;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      word += command[index];
      started = true;
      continue;
    }
    if (SEGMENT_SEPARATORS.test(char)) {
      endSegment();
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    started = true;
  }

  if (quote) {
    // An unterminated quote is not a command anybody can reason about. What is
    // collected so far is scanned rather than dropped.
    endSegment();
  } else {
    endSegment();
  }
  return segments;
}

/** The file name of an executable, with any directory and `.exe` removed. */
function executableName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** The subcommand one shell command would give git, if it invokes git at all. */
function gitSubcommandOf(words: string[]): string | undefined {
  let index = 0;

  // Leading `FOO=bar` assignments and wrappers like `sudo` come before the
  // program that actually runs.
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1;
    else if (COMMAND_PREFIXES.has(executableName(word))) index += 1;
    else break;
  }

  if (index >= words.length || executableName(words[index]!) !== 'git') return undefined;
  index += 1;

  while (index < words.length) {
    const word = words[index]!;
    if (!word.startsWith('-')) return word.toLowerCase();
    // `--git-dir=x` carries its value; `--git-dir x` eats the next word.
    if (!word.includes('=') && GIT_OPTIONS_WITH_VALUE.has(word)) index += 2;
    else index += 1;
  }
  return undefined;
}

/**
 * Check whether a command runs a git subcommand the session may not run.
 *
 * The check is structural, not textual: `git push`, `git -C . push`,
 * `/usr/bin/git push` and `git -c user.name=x commit` are the same command
 * wearing different clothes, and all four are refused.
 */
export function hasForbiddenGitSubcommand(command: string): boolean {
  return shellSegments(command).some((words) => {
    const subcommand = gitSubcommandOf(words);
    return subcommand !== undefined && FORBIDDEN_GIT_SUBCOMMANDS.has(subcommand);
  });
}

/**
 * Check if a command is a commit task (commit-task.ts).
 */
export function isCommitTaskCommand(command: string): boolean {
  return /commit-task\.ts\b/.test(command.trim());
}

/** Shell syntax that writes, or that hides what actually runs. */
const WRITES_OR_HIDES = /[>]|\$\(|`|<\(/u;

/**
 * True when every command in the line is known not to change the working tree.
 *
 * `bash` is in the runtime's `mutatingTools` because it usually is one, so a
 * read had to satisfy a lifecycle built for writes: `git status --short` was
 * refused before the plan was approved, and refused afterwards with "Cannot
 * resolve a single workflow task run for mutation" whenever the session had no
 * runnable task.
 *
 * Structural, like `hasForbiddenGitSubcommand`, and over the same tokeniser —
 * `"git" status`, `/usr/bin/git status` and `git -C sub status` are one
 * command in different clothes. It fails closed at every turn: an unknown
 * name, an unknown git subcommand, any redirection or substitution, any
 * wrapper that could run something else, and the answer is `false`. A command
 * wrongly admitted here runs with no baseline and no frame diff behind it,
 * which is a far worse outcome than a read being asked to wait.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  if (command.trim() === '') return false;
  if (WRITES_OR_HIDES.test(command)) return false;

  const segments = shellSegments(command);
  if (segments.length === 0) return false;

  return segments.every((words) => {
    // A leading `FOO=bar` or a wrapper like `sudo` hides the real program.
    // `gitSubcommandOf` looks through them deliberately; here they are a
    // reason to refuse, because looking through them is exactly the guess
    // this classifier must not make.
    const first = words[0];
    if (first === undefined) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false;

    const name = executableName(first);
    if (COMMAND_PREFIXES.has(name)) return false;

    if (name === 'git') {
      const subcommand = gitSubcommandOf(words);
      if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
      return true;
    }

    // `sort` is only read-only when it writes to stdout. `-o FILE` and its
    // long forms replace the input file or create the requested output file.
    if (
      name === 'sort' &&
      words.slice(1).some((word) => /^-o(?:$|[^-].*)/.test(word) || /^--output(?:=|$)/.test(word))
    ) {
      return false;
    }

    return READ_ONLY_COMMANDS.has(name);
  });
}
