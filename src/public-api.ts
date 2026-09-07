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
