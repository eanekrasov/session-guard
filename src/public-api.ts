import type { ProfileMetadata, ResolvedProfile } from './schema/types.ts';
import { ProfileResolver } from './profile-resolver.ts';

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
