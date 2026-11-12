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
import { ProfileResolver, schemaId } from './app/profile-resolver.ts';
import { opencodeStateDir, profilesDir, sessionsDir } from './app/paths.ts';
import { syncAllProfileAgents } from './app/profile-agent-sync.ts';
import { compileWorkflow } from './schema/compile-workflow.ts';
import { archiveDirOf, listSessionIds } from './session/session-files.ts';
import { WorkflowStore } from './session/session-store.ts';

const USAGE = `Usage: session-guard sync-agents [--cwd <dir>]
       session-guard validate-schemas [--cwd <dir>]
       session-guard sessions schemas [--cwd <dir>] [--json]
       session-guard sessions list [--json]
       session-guard sessions archived [--json]
       session-guard sessions show <id> [--archived] [--json]
       session-guard sessions restore <id>
       session-guard sessions delete <id> [--archived]
       session-guard sessions clear (--archived | --all) --yes

Commands:
  sync-agents       Synchronize profile agents into the harness
  validate-schemas  Validate all profile workflow schemas
  sessions schemas  List workflow schemas with descriptions
  sessions list     List active workflow sessions
  sessions archived List archived workflow sessions
  sessions show     Print one session as JSON
  sessions restore  Move one archived session back to active storage
  sessions delete   Delete one active session, or one archived session with --archived
  sessions clear    Delete all archived sessions or all sessions (--yes required)

Read-only session commands accept --json for machine-readable output.

Writes every profile's agents into <dir>/.opencode/agents, derived from the
profiles under <dir>/.opencode/profiles. A file this tool did not write is
never overwritten or removed — it is reported as a collision instead.

Options:
  --cwd <dir>   Project root for sync-agents and sessions schemas; defaults to the current directory.
  -h, --help    Show this message.

Environment:
  OPENCODE_HARNESS_DIR         Overrides the harness directory (.opencode).
  SESSION_GUARD_PROFILES_DIR   Overrides where profiles are read from.
  SESSION_GUARD_STORE_DIR      Overrides where active and archived sessions are stored.

Exit codes:
  0  nothing failed
  1  operation failed, schema validation failed, or requested session was not found
  2  the arguments were not understood`;

type ParsedArguments =
  | { kind: 'run'; command: 'sync-agents' | 'validate-schemas'; cwd: string }
  | { kind: 'sessions-schemas'; cwd: string; json: boolean }
  | { kind: 'sessions-list'; json: boolean }
  | { kind: 'sessions-archived'; json: boolean }
  | { kind: 'sessions-show'; sessionId: string; archived: boolean; json: boolean }
  | { kind: 'sessions-restore'; sessionId: string }
  | { kind: 'sessions-delete'; sessionId: string; archived: boolean }
  | { kind: 'sessions-clear'; target: 'archived' | 'all' }
  | { kind: 'help' }
  | { kind: 'usage-error'; message: string };

function parseCwdArguments(args: string[]): { cwd: string } | { message: string } | { help: true } {
  let cwd: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '-h' || argument === '--help') return { help: true };
    if (argument === '--cwd') {
      const value = args[index + 1];
      if (value === undefined) return { message: '--cwd needs a directory' };
      cwd = value;
      index += 1;
    } else if (argument.startsWith('--cwd=')) {
      const value = argument.slice('--cwd='.length);
      if (value === '') return { message: '--cwd needs a directory' };
      cwd = value;
    } else {
      return { message: `unknown argument: ${argument}` };
    }
  }
  return { cwd: resolve(cwd ?? process.cwd()) };
}

function parseSessionsArguments(args: string[], json: boolean): ParsedArguments {
  const [action, ...rest] = args;
  if (action === '-h' || action === '--help') return { kind: 'help' };
  if (action === 'schemas') {
    const parsed = parseCwdArguments(rest);
    if ('help' in parsed) return { kind: 'help' };
    if ('message' in parsed) return { kind: 'usage-error', message: parsed.message };
    return { kind: 'sessions-schemas', cwd: parsed.cwd, json };
  }
  if (action === 'archived') {
    if (rest.length > 0) return { kind: 'usage-error', message: `unknown argument: ${rest[0]}` };
    return { kind: 'sessions-archived', json };
  }
  if (action === 'list') {
    if (rest.length > 0) return { kind: 'usage-error', message: `unknown argument: ${rest[0]}` };
    return { kind: 'sessions-list', json };
  }
  if (action === 'show') {
    const [sessionId, ...options] = rest;
    if (!sessionId || sessionId.startsWith('-')) {
      return { kind: 'usage-error', message: 'sessions show needs a session id' };
    }
    if (options.some((option) => option !== '--archived')) {
      return {
        kind: 'usage-error',
        message: `unknown argument: ${options.find((option) => option !== '--archived')}`,
      };
    }
    return { kind: 'sessions-show', sessionId, archived: options.includes('--archived'), json };
  }
  if (action === 'restore') {
    const [sessionId, ...options] = rest;
    if (!sessionId || sessionId.startsWith('-')) {
      return { kind: 'usage-error', message: 'sessions restore needs a session id' };
    }
    if (options.length > 0) {
      return { kind: 'usage-error', message: `unknown argument: ${options[0]}` };
    }
    return { kind: 'sessions-restore', sessionId };
  }
  if (action === 'delete') {
    const [sessionId, ...options] = rest;
    if (!sessionId || sessionId.startsWith('-')) {
      return { kind: 'usage-error', message: 'sessions delete needs a session id' };
    }
    if (options.some((option) => option !== '--archived')) {
      return {
        kind: 'usage-error',
        message: `unknown argument: ${options.find((option) => option !== '--archived')}`,
      };
    }
    return { kind: 'sessions-delete', sessionId, archived: options.includes('--archived') };
  }
  if (action === 'clear') {
    let target: 'archived' | 'all' | undefined;
    let confirmed = false;
    for (const argument of rest) {
      if (argument === '--yes') {
        confirmed = true;
      } else if (argument === '--archived' || argument === '--all') {
        if (target !== undefined) {
          return { kind: 'usage-error', message: 'choose only one of --archived or --all' };
        }
        target = argument === '--all' ? 'all' : 'archived';
      } else {
        return { kind: 'usage-error', message: `unknown argument: ${argument}` };
      }
    }
    if (target === undefined) {
      return { kind: 'usage-error', message: 'sessions clear requires --archived or --all' };
    }
    if (!confirmed) return { kind: 'usage-error', message: 'sessions clear requires --yes' };
    return { kind: 'sessions-clear', target };
  }
  return {
    kind: 'usage-error',
    message:
      action === undefined ? 'sessions needs a subcommand' : `unknown sessions command: ${action}`,
  };
}

function parseArguments(argv: string[]): ParsedArguments {
  const json = argv.includes('--json');
  const args = argv.filter((argument) => argument !== '--json');
  if (args[0] === '-h' || args[0] === '--help') return { kind: 'help' };
  if (args[0] === 'sessions') {
    const parsed = parseSessionsArguments(args.slice(1), json);
    if (
      json &&
      !['sessions-schemas', 'sessions-list', 'sessions-archived', 'sessions-show'].includes(
        parsed.kind
      )
    ) {
      return {
        kind: 'usage-error',
        message: '--json is only supported for read-only sessions commands',
      };
    }
    return parsed;
  }
  if (json)
    return {
      kind: 'usage-error',
      message: '--json is only supported for read-only sessions commands',
    };
  const hasCommand = args[0] === 'sync-agents' || args[0] === 'validate-schemas';
  if (!hasCommand && args[0] !== undefined && !args[0].startsWith('--cwd')) {
    return {
      kind: 'usage-error',
      message: args[0].startsWith('-')
        ? `unknown argument: ${args[0]}`
        : `unknown command: ${args[0]}`,
    };
  }
  const command = hasCommand ? args[0] : 'sync-agents';
  if (command !== 'sync-agents' && command !== 'validate-schemas') {
    return { kind: 'usage-error', message: `unknown command: ${command}` };
  }

  let cwd: string | undefined;

  for (let index = hasCommand ? 1 : 0; index < args.length; index += 1) {
    const argument = args[index]!;

    if (argument === '-h' || argument === '--help') return { kind: 'help' };

    if (argument === '--cwd') {
      const value = args[index + 1];
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

function createSessionStore(): WorkflowStore {
  return new WorkflowStore(sessionsDir(opencodeStateDir()));
}

async function listSchemas(cwd: string, json: boolean): Promise<number> {
  const resolver = new ProfileResolver(profilesDir(cwd));
  const profiles = await resolver.listProfiles();
  const resolved = json
    ? await Promise.all(
        profiles.map(async (profile) => {
          const config = await resolver.resolve(profile.id);
          return {
            profileId: profile.id,
            profile: {
              id: config.metadata.id,
              description: config.metadata.description,
              agents: config.metadata.agents,
              skills: config.metadata.skills,
              invariants: config.metadata.invariants,
            },
            schemas: config.schemas.map((schema) => ({
              id: schema.id,
              description: schema.description ?? profile.schemaDescriptions?.[schema.id] ?? '',
              stages: schema.stages ?? {},
              transitions: schema.transitions ?? [],
            })),
          };
        })
      )
    : [];
  if (json) {
    stdout(JSON.stringify(resolved));
    return 0;
  }
  let count = 0;
  for (const profile of profiles) {
    for (const file of profile.schemas ?? []) {
      const description = profile.schemaDescriptions?.[file];
      stdout(
        `${profile.id}/${schemaId(file)}${description === undefined ? '' : `: ${description}`}`
      );
      count++;
    }
  }
  if (count === 0) stdout('No workflow schemas found.');
  return 0;
}

async function listSessions(archived: boolean, json: boolean): Promise<number> {
  const store = createSessionStore();
  const ids = archived
    ? await listSessionIds(archiveDirOf(sessionsDir(opencodeStateDir())))
    : await store.list();
  if (ids.length === 0) {
    stdout(json ? '[]' : `No ${archived ? 'archived ' : 'active '}sessions.`);
    return 0;
  }
  const sessions = await Promise.all(
    ids.map(async (id) => {
      try {
        return archived ? await store.loadArchived(id) : await store.load(id);
      } catch (error) {
        if (json) return null;
        throw error;
      }
    })
  );
  if (json) {
    stdout(JSON.stringify(sessions.filter((session) => session !== null)));
    return 0;
  }
  stdout('ID | PROFILE/SCHEMA | STAGE | UPDATED');
  for (const [index, id] of ids.entries()) {
    const session = sessions[index];
    stdout(
      session
        ? `${id} | ${session.profileId}/${session.schemaId} | ${session.currentStage} | ${session.updatedAt}`
        : `${id} | unreadable session`
    );
  }
  return 0;
}

async function showSession(sessionId: string, archived: boolean): Promise<number> {
  const store = createSessionStore();
  const session = archived ? await store.loadArchived(sessionId) : await store.load(sessionId);
  if (!session) {
    stderr(`No ${archived ? 'archived ' : 'active '}session found: ${sessionId}`);
    return 1;
  }
  stdout(JSON.stringify(session, null, 2));
  return 0;
}

async function restoreSession(sessionId: string): Promise<number> {
  const result = await createSessionStore().restoreArchived(sessionId);
  if (result === 'restored') {
    stdout(`Restored archived session ${sessionId}.`);
    return 0;
  }
  stderr(
    result === 'active_exists'
      ? `Cannot restore session ${sessionId}: an active session with this id already exists.`
      : `No archived session found: ${sessionId}`
  );
  return 1;
}

async function deleteSession(sessionId: string, archived: boolean): Promise<number> {
  const store = createSessionStore();
  const archivedDirectory = archiveDirOf(sessionsDir(opencodeStateDir()));
  const ids = archived ? await listSessionIds(archivedDirectory) : await store.list();
  if (!ids.includes(sessionId)) {
    stderr(`No ${archived ? 'archived ' : ''}session found: ${sessionId}`);
    return 1;
  }
  if (archived) await store.deleteArchived(sessionId);
  else await store.delete(sessionId);
  stdout(`Deleted ${archived ? 'archived ' : ''}session ${sessionId}.`);
  return 0;
}

async function clearSessions(target: 'archived' | 'all'): Promise<number> {
  const store = createSessionStore();
  const archivedIds = await listSessionIds(archiveDirOf(sessionsDir(opencodeStateDir())));
  const activeIds = target === 'all' ? await store.list() : [];
  for (const id of activeIds) await store.delete(id);
  for (const id of archivedIds) await store.deleteArchived(id);
  stdout(`Deleted ${activeIds.length + archivedIds.length} ${target} session(s).`);
  return 0;
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
    stderr(`session-guard: ${parsed.message}`);
    stderr('');
    stderr(USAGE);
    return 2;
  }

  if (parsed.kind === 'sessions-schemas') return listSchemas(parsed.cwd, parsed.json);
  if (parsed.kind === 'sessions-list') return listSessions(false, parsed.json);
  if (parsed.kind === 'sessions-archived') return listSessions(true, parsed.json);
  if (parsed.kind === 'sessions-show') return showSession(parsed.sessionId, parsed.archived);
  if (parsed.kind === 'sessions-restore') return restoreSession(parsed.sessionId);
  if (parsed.kind === 'sessions-delete') return deleteSession(parsed.sessionId, parsed.archived);
  if (parsed.kind === 'sessions-clear') return clearSessions(parsed.target);

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
