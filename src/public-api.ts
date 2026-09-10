import type { ProfileMetadata, ResolvedProfile } from './schema/types.ts';
import { ProfileResolver } from './app/profile-resolver.ts';
import type { StageGateResult, WorkflowSession } from './session/session-schema.ts';

/**
 * Gate results visible at the current outer workflow step.
 *
 * The session stores results only after an outer stage has actually produced
 * them. The current stage's declared gates are added as `pending` when no
 * result exists yet. Nested loop gates deliberately stay on `loopRuns` and do
 * not enter this projection.
 */
export async function getCurrentStageGates(
  session: WorkflowSession,
  profilesDir: string
): Promise<StageGateResult[]> {
  const resolved = await resolveConfig(session.profileId, profilesDir);
  const schema =
    resolved.schemas.find((candidate) => candidate.id === session.schemaId) ??
    (resolved.schemas.length === 1 ? resolved.schemas[0] : undefined);
  const currentStage = schema?.stages?.[session.currentStage];
  const outerStageIds = new Set(Object.keys(schema?.stages ?? {}));
  const results = session.stageGateResults
    .filter((result) => outerStageIds.has(result.stage))
    .map((result) => ({ ...result }));

  for (const gateId of currentStage?.gates ?? []) {
    if (results.some((result) => result.stage === session.currentStage && result.id === gateId)) {
      continue;
    }
    results.push({ stage: session.currentStage, id: gateId, status: 'pending' });
  }

  return results;
}

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
  archiveDirOf,
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
