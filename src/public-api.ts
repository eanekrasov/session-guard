import type { ProfileMetadata, ResolvedProfile } from './schema/types.ts';
import { ProfileResolver } from './app/profile-resolver.ts';

/**
 * Resolve a profile's full configuration.
 */
export async function resolveConfig(
  profileId: string,
  profilesDir: string
): Promise<ResolvedProfile> {
  const resolver = new ProfileResolver(profilesDir);
  return resolver.resolve(profileId);
}

/**
 * List all available profiles. Returns flat metadata, no extends resolution.
 */
export async function listProfiles(profilesDir: string): Promise<ProfileMetadata[]> {
  const resolver = new ProfileResolver(profilesDir);
  return resolver.listProfiles();
}

/**
 * Reading sessions off disk, for the TUI and the dashboard.
 *
 * Both used to read the store directory themselves and both knew the file
 * naming rule independently — which is how they drifted apart from the store
 * and from each other. This is the one door.
 */
export {
  listSessionIds,
  readAllSessions,
  readSession,
  sessionFileName,
  sessionIdFromFileName,
} from './session/session-files.ts';

/**
 * The agents a profile ships. The profile is the source; nobody keeps a list.
 *
 * The dashboard used to guard its prompt endpoint with a literal array of ten
 * names. It matched `profiles/android/agents` exactly — android being the only
 * profile that ships agents — so the copy could not visibly drift, and a second
 * profile's agent would have been refused with a 400 while its prompt sat on
 * disk.
 */
export { listProfileAgents } from './app/profile-agent-sync.ts';
