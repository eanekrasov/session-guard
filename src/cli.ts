#!/usr/bin/env bun
/**
 * `session-guard sync-agents` — write every profile's agents into the harness
 * agents directory without starting OpenCode.
 *
 * The plugin already does this on startup, in its `config` hook, which is
 * enough while a session is running. This command exists for the moments when
 * it is not: after a pull brought new profile agents and you want them
 * registered before opening a session, or from a provisioning script that
 * prepares a project before anything reads it.
 *
 * The synchronization itself lives in `app/profile-agent-sync.ts`, shared with
 * the plugin's startup path, so there is one implementation of it and not two.
 */
import { resolve } from 'node:path';
import { ProfileResolver } from './app/profile-resolver.ts';
import { profilesDir } from './app/paths.ts';
import { syncAllProfileAgents } from './app/profile-agent-sync.ts';
import { compileWorkflow } from './schema/compile-workflow.ts';

const USAGE = `Usage: session-guard sync-agents [--cwd <dir>]
       session-guard validate-schemas [--cwd <dir>]

Commands:
  sync-agents       Synchronize profile agents into the harness
  validate-schemas  Validate all profile workflow schemas

Writes every profile's agents into <dir>/.opencode/agents, derived from the
profiles under <dir>/.opencode/profiles. A file this tool did not write is
never overwritten or removed — it is reported as a collision instead.

Options:
  --cwd <dir>   Project root to synchronize. Defaults to the current directory.
  -h, --help    Show this message.

Environment:
  OPENCODE_HARNESS_DIR         Overrides the harness directory (.opencode).
  SESSION_GUARD_PROFILES_DIR   Overrides where profiles are read from.

Exit codes:
  0  nothing failed
  1  at least one file could not be synchronized
  2  the arguments were not understood`;

type ParsedArguments =
  | { kind: 'run'; command: 'sync-agents' | 'validate-schemas'; cwd: string }
  | { kind: 'help' }
  | { kind: 'usage-error'; message: string };

function parseArguments(argv: string[]): ParsedArguments {
  if (argv[0] === '-h' || argv[0] === '--help') return { kind: 'help' };
  const hasCommand = argv[0] === 'sync-agents' || argv[0] === 'validate-schemas';
  if (!hasCommand && argv[0] !== undefined && !argv[0].startsWith('--cwd')) {
    return {
      kind: 'usage-error',
      message: argv[0].startsWith('-')
        ? `unknown argument: ${argv[0]}`
        : `unknown command: ${argv[0]}`,
    };
  }
  const command = hasCommand ? argv[0] : 'sync-agents';
  if (command !== 'sync-agents' && command !== 'validate-schemas') {
    return { kind: 'usage-error', message: `unknown command: ${command}` };
  }

  let cwd: string | undefined;

  for (let index = hasCommand ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '-h' || argument === '--help') return { kind: 'help' };

    if (argument === '--cwd') {
      const value = argv[index + 1];
      if (value === undefined) return { kind: 'usage-error', message: '--cwd needs a directory' };
      cwd = value;
      index += 1;
      continue;
    }

    if (argument.startsWith('--cwd=')) {
      const value = argument.slice('--cwd='.length);
      if (value === '') return { kind: 'usage-error', message: '--cwd needs a directory' };
      cwd = value;
      continue;
    }

    return { kind: 'usage-error', message: `unknown argument: ${argument}` };
  }

  return { kind: 'run', command, cwd: resolve(cwd ?? process.cwd()) };
}

/** Written to stdout, which is what the sync uses for its own log sink. */
function stdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Written to stderr: something needs a human, but the run itself may be fine.
 *
 * Collisions are the reason this exists. A file this tool did not write, at a
 * name it wanted, is skipped rather than overwritten — a real outcome that
 * still exits 0, and one that would be missed in a log nobody reads.
 */
function stderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.kind === 'help') {
    stdout(USAGE);
    return 0;
  }

  if (parsed.kind === 'usage-error') {
    stderr(`sync-agents: ${parsed.message}`);
    stderr('');
    stderr(USAGE);
    return 2;
  }

  if (parsed.command === 'validate-schemas') {
    const resolver = new ProfileResolver(profilesDir(parsed.cwd));
    let failures = 0;
    const profiles = await resolver.listProfiles();
    if (profiles.length === 0) {
      stderr('No profiles found.');
      return 1;
    }
    for (const profile of profiles) {
      try {
        const resolved = await resolver.resolve(profile.id);
        for (const schema of resolved.schemas) {
          const errors = compileWorkflow(schema).errors.filter(
            (error) => error.severity === 'error'
          );
          if (errors.length > 0) {
            failures += errors.length;
            for (const error of errors)
              stderr(`${profile.id}/${schema.id}: ${error.path}: ${error.message}`);
          } else {
            stdout(`${profile.id}/${schema.id}: valid`);
          }
        }
      } catch (error) {
        failures += 1;
        stderr(`${profile.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    stdout(`Validation: ${failures === 0 ? 'all schemas valid' : `${failures} error(s)`}`);
    return failures > 0 ? 1 : 0;
  }

  const report = await syncAllProfileAgents(parsed.cwd, stdout);

  let synced = 0;
  let removed = 0;
  let collisions = 0;
  let errors = 0;

  for (const outcome of report.profiles) {
    synced += outcome.synced.length;
    removed += outcome.removed.length;
    collisions += outcome.collisions.length;
    errors += outcome.errors.length;

    stdout(
      `${outcome.profileId}: ${outcome.synced.length} synced, ${outcome.removed.length} removed, ` +
        `${outcome.collisions.length} collisions, ${outcome.errors.length} errors`
    );

    for (const collision of outcome.collisions) {
      stderr(`sync-agents: ${outcome.profileId} left an unowned "${collision}" untouched`);
    }

    for (const error of outcome.errors) {
      stderr(`sync-agents: ${outcome.profileId}: ${error}`);
    }
  }

  for (const error of report.errors) {
    stderr(`sync-agents: ${error}`);
  }

  stdout(
    `Total: ${synced} synced, ${removed} removed, ${collisions} collisions, ${errors} errors ` +
      `across ${report.profiles.length} profile(s)`
  );

  // A collision is a decision left to the human, not a failure of this run;
  // only something that could not be written at all makes the command fail.
  return report.errors.length + errors > 0 ? 1 : 0;
}

process.exitCode = await main();
