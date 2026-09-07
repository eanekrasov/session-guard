import { readdir, readFile, unlink, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { profilesDir, harnessDir } from './paths.ts';

const MANAGED_MARKER_LINE = '# MANAGED BY session-guard — do not edit';

/**
 * Check whether `content` is owned by this plugin.
 *
 * Ownership is recognised at two locations:
 *   1. After YAML frontmatter (i.e. the first non-frontmatter line).
 *   2. The very first line of the file (legacy — pre-frontmatter awareness).
 */
function isOwned(content: string): boolean {
  const firstLine = content.split('\n', 1)[0];
  if (firstLine === MANAGED_MARKER_LINE) return true;

  if (firstLine.trim() === '---') {
    const endFm = content.indexOf('\n---\n', 1);
    if (endFm !== -1) {
      const lineAfterFm = content
        .slice(endFm + 5)
        .split('\n', 1)[0]
        .trimEnd();
      return lineAfterFm === MANAGED_MARKER_LINE;
    }
  }

  return false;
}

/**
 * Read a target file's bytes, returning `null` if the file does not exist.
 */
async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

function injectManagedMarker(content: string): string {
  const firstLine = content.split('\n', 1)[0];
  if (firstLine.trim() === '---') {
    const endFm = content.indexOf('\n---\n', 1);
    if (endFm !== -1) {
      const beforeBody = content.slice(0, endFm + 5);
      const body = content.slice(endFm + 5);
      return beforeBody + MANAGED_MARKER_LINE + '\n' + body;
    }
  }
  return MANAGED_MARKER_LINE + '\n' + content;
}

/**
 * Sync profile agents into .opencode/agents/ so OpenCode discovers them.
 *
 * Scans `<projectDir>/profiles/<profileId>/<agentsDir>/*.md` and copies each
 * file into `.opencode/agents/<profileId>/<filename>`, prepending a managed
 * ownership marker. Existing files under `.opencode/agents/<profileId>/` that do
 * not correspond to current source files are removed **only if owned**.
 * Unowned files with matching filenames are preserved byte-for-byte and a
 * collision diagnostic is emitted. User-created files in `.opencode/agents/`
 * outside the profile subdirectory are never touched.
 *
 * Ownership is determined by checking `isOwned()` on the target file content.
 * The marker is placed **after** YAML frontmatter when present, or at the
 * beginning of the file when no frontmatter exists.
 */
/**
 * The agents a profile ships.
 *
 * `profile.json`'s `agents` is the source of truth when the profile declares
 * one. When it does not, the default is what the agents directory holds — the
 * profile ships what it ships, and there is no second list to keep in step.
 *
 * Only the profile's own declaration counts here, never an inherited one:
 * these names have to match files under this profile's own directory, and an
 * ancestor's roster describes the ancestor's.
 *
 * Names come back bare (`code`); `qualifyAgentName` makes them `android/code`.
 */
export async function listProfileAgents(
  profileId: string,
  profilesDirectory: string
): Promise<string[]> {
  let agentsSubdir = 'agents';
  let declared: string[] | undefined;
  try {
    const meta = JSON.parse(
      await readFile(path.join(profilesDirectory, profileId, 'profile.json'), 'utf-8')
    ) as { agentsDir?: string; agents?: string[] };
    agentsSubdir = meta.agentsDir ?? 'agents';
    if (Array.isArray(meta.agents)) declared = meta.agents;
  } catch {
    // No profile.json, or unreadable: the default subdirectory is still worth a look.
  }
  // A declared roster keeps the order its author wrote; only the directory
  // listing is sorted, because a directory has no order of its own.
  if (declared !== undefined) return [...new Set(declared)];

  try {
    const entries = await readdir(path.join(profilesDirectory, profileId, agentsSubdir), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
  } catch {
    return [];
  }
}

export async function syncProfileAgents(
  profileId: string,
  projectDir: string,
  log?: (msg: string) => void
): Promise<void> {
  const logMsg = log ?? (() => {});

  const pDir = profilesDir(projectDir);
  const hDir = harnessDir(projectDir);
  const opencodeAgentsDir = path.join(hDir, 'agents');

  // Load profile metadata to find agentsDir
  const profileJsonPath = path.join(pDir, profileId, 'profile.json');
  if (!existsSync(profileJsonPath)) {
    logMsg(`[profile-agent-sync] No profile.json for "${profileId}" at ${profileJsonPath}`);
    return;
  }

  let profileMeta: { agentsDir?: string };
  try {
    profileMeta = JSON.parse(await readFile(profileJsonPath, 'utf-8'));
  } catch (err) {
    logMsg(
      `[profile-agent-sync] Failed to parse ${profileJsonPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const sourceAgentsDir = path.join(pDir, profileId, profileMeta.agentsDir ?? 'agents');
  const targetAgentsDir = path.join(opencodeAgentsDir, profileId);

  // Collect source files (*.md only), keeping to the profile's roster: a
  // declared `agents` list is the source of truth, and what it leaves out is
  // not this profile's to register.
  const roster = new Set(await listProfileAgents(profileId, pDir));
  let sourceFiles: string[];
  if (!existsSync(sourceAgentsDir)) {
    logMsg(`[profile-agent-sync] Source agents dir does not exist: ${sourceAgentsDir}`);
    sourceFiles = [];
  } else {
    try {
      const entries = await readdir(sourceAgentsDir, { withFileTypes: true });
      sourceFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .filter((name) => {
          if (roster.has(name.slice(0, -'.md'.length))) return true;
          logMsg(`[profile-agent-sync] "${name}" is not on ${profileId}'s agents list; skipped`);
          return false;
        });
    } catch (err) {
      logMsg(
        `[profile-agent-sync] Error reading ${sourceAgentsDir}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
  }

  // Collect target files already managed by this profile
  let existingTargetFiles: string[];
  try {
    const entries = await readdir(targetAgentsDir, { withFileTypes: true });
    existingTargetFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    existingTargetFiles = [];
  }

  // Remove stale owned files only
  const staleFiles = existingTargetFiles.filter((name) => !sourceFiles.includes(name));
  for (const stale of staleFiles) {
    const targetPath = path.join(targetAgentsDir, stale);
    const targetContent = await tryReadFile(targetPath);

    if (targetContent !== null && !isOwned(targetContent)) {
      logMsg(
        `[profile-agent-sync] COLLISION: unowned file "${stale}" at ${targetPath} would be stale — preserved unchanged`
      );
      continue;
    }

    try {
      await unlink(targetPath);
      logMsg(`[profile-agent-sync] Removed stale agent: ${stale}`);
    } catch (err) {
      logMsg(
        `[profile-agent-sync] Error removing stale agent ${stale}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Copy source files to target with managed marker
  for (const sourceFile of sourceFiles) {
    const sourcePath = path.join(sourceAgentsDir, sourceFile);
    const targetPath = path.join(targetAgentsDir, sourceFile);

    try {
      let content: string;
      try {
        content = await readFile(sourcePath, 'utf-8');
      } catch (err) {
        logMsg(
          `[profile-agent-sync] Error reading ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      // If target exists and is not owned, preserve it with a diagnostic
      const existingTarget = await tryReadFile(targetPath);
      if (existingTarget !== null && !isOwned(existingTarget)) {
        logMsg(
          `[profile-agent-sync] COLLISION: unowned file "${sourceFile}" at ${targetPath} preserved unchanged`
        );
        continue;
      }

      const prefixed = content.startsWith(MANAGED_MARKER_LINE + '\n')
        ? content
        : injectManagedMarker(content);

      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, prefixed, 'utf-8');
      logMsg(`[profile-agent-sync] Synced agent: ${sourceFile}`);
    } catch (err) {
      logMsg(
        `[profile-agent-sync] Error copying ${sourceFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await markGenerated(targetAgentsDir, logMsg);
}

/**
 * Mark this profile's synced directory as generated, so git leaves it alone.
 *
 * These files are copies of `profiles/<id>/agents/*.md`, which is what is
 * actually committed — they are derived, and they carry an ownership marker
 * saying so. Left untracked they are swept up by `commit-task.ts`, which
 * stages everything when it is given no paths, and the commit then carries
 * files no task ever touched. The delivery permit expected none of them, so
 * the receipt was refused and the workflow stopped in `commit` — with the
 * agent seeing only 'nothing staged to commit' from the retry that followed.
 *
 * The ignore file sits inside the profile's own subdirectory, so anything a
 * user keeps elsewhere under `.opencode/agents/` is untouched — the same
 * boundary the sync itself respects.
 */
async function markGenerated(
  targetAgentsDir: string,
  logMsg: (msg: string) => void
): Promise<void> {
  const ignorePath = path.join(targetAgentsDir, '.gitignore');
  try {
    if (existsSync(ignorePath)) return;
    await mkdir(targetAgentsDir, { recursive: true });
    await writeFile(
      ignorePath,
      '# Generated by session-guard from profiles/<id>/agents. Do not commit.\n*\n',
      'utf-8'
    );
    logMsg(`[profile-agent-sync] Marked ${targetAgentsDir} as generated`);
  } catch (err) {
    logMsg(
      `[profile-agent-sync] Could not mark ${targetAgentsDir} as generated: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
