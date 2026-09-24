import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import { Agent } from '@opencode/schema/agent';
import { listProfileAgents, syncAllProfileAgents, type SyncReport } from './profile-agent-sync.ts';
import { qualifyAgentName } from './agent-names.ts';

interface ProfileAgentMetadata {
  description?: string;
  mode?: 'subagent' | 'primary' | 'all';
  color?: string;
}

interface ProfileAgentUpdate {
  id: string;
  metadata: ProfileAgentMetadata;
  system: string;
}

function readFrontmatter(content: string): { metadata: ProfileAgentMetadata; system: string } {
  if (!content.startsWith('---\n')) return { metadata: {}, system: content.trim() };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { metadata: {}, system: content.trim() };

  const raw = parse(content.slice(4, end)) as Record<string, unknown>;
  const metadata: ProfileAgentMetadata = {};
  if (typeof raw.description === 'string') metadata.description = raw.description;
  if (raw.mode === 'subagent' || raw.mode === 'primary' || raw.mode === 'all') {
    metadata.mode = raw.mode;
  }
  if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/u.test(raw.color)) {
    metadata.color = raw.color;
  }
  return { metadata, system: content.slice(end + 5).trim() };
}

async function loadUpdates(
  report: SyncReport,
  profilesDirectory: string,
  log: (message: string) => void
): Promise<ProfileAgentUpdate[]> {
  const updates: ProfileAgentUpdate[] = [];
  for (const profile of report.profiles) {
    let agentsDir = 'agents';
    try {
      const profileJson = JSON.parse(
        await readFile(path.join(profilesDirectory, profile.profileId, 'profile.json'), 'utf8')
      ) as { agentsDir?: string };
      agentsDir = profileJson.agentsDir ?? 'agents';
    } catch (error) {
      log(
        `[profile-agent-sync] Failed to load metadata for "${profile.profileId}": ${formatError(error)}`
      );
      continue;
    }

    for (const agentName of await listProfileAgents(profile.profileId, profilesDirectory)) {
      try {
        const source = await readFile(
          path.join(profilesDirectory, profile.profileId, agentsDir, `${agentName}.md`),
          'utf8'
        );
        const parsed = readFrontmatter(source);
        updates.push({
          id: qualifyAgentName(profile.profileId, agentName),
          metadata: parsed.metadata,
          system: parsed.system,
        });
      } catch (error) {
        log(
          `[profile-agent-sync] Failed to load agent "${profile.profileId}/${agentName}": ${formatError(error)}`
        );
      }
    }
  }
  return updates;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sync profile files, then materialize their catalog entries through the V2 editor. */
export async function registerV2ProfileAgents(
  context: Context,
  projectDirectory: string,
  profilesDirectory: string,
  log: (message: string) => void
): Promise<Registration> {
  const report = await syncAllProfileAgents(projectDirectory, log, profilesDirectory);
  for (const error of report.errors) log(`[profile-agent-sync] ${error}`);
  for (const profile of report.profiles) {
    for (const error of profile.errors) log(`[profile-agent-sync] ${error}`);
  }
  const updates = await loadUpdates(report, profilesDirectory, log);

  return context.agent.transform((editor) => {
    for (const update of updates) {
      editor.update(update.id, (agent) => {
        agent.name = Agent.Name.make(update.id);
        agent.system = update.system;
        if (update.metadata.description !== undefined)
          agent.description = update.metadata.description;
        if (update.metadata.mode !== undefined) agent.mode = update.metadata.mode;
        if (update.metadata.color !== undefined) agent.color = update.metadata.color;
      });
    }
  });
}
