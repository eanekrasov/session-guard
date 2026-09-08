/**
 * Agent names as OpenCode sees them.
 *
 * `syncProfileAgents` copies `profiles/<id>/<agentsDir>/<name>.md` into a flat
 * `.opencode/agents/<id>_<name>.md`, and OpenCode derives an agent's name from
 * the path under `agent/` or `agents/`. A profile's `code.md` therefore
 * registers as `<id>_code`, never bare `code`.
 *
 * The separator is `_` because the directory is flat: the profile has to live
 * in the file name, and two profiles ship agents of the same name — `base` and
 * `android` both ship `code.md`.
 *
 * Schemas stay authored with bare names; resolution qualifies them so the
 * runtime can compare against what the host actually reports.
 */

const SEPARATOR = '_';

/**
 * True when `name` already carries this profile's prefix.
 *
 * The test is against the profile, not against the separator: an agent may be
 * named `code_review` on its own, and treating every underscore as a prefix
 * would read that as profile `code`, agent `review`.
 */
export function isQualifiedAgentName(name: string, profileId: string): boolean {
  return name.startsWith(profileId + SEPARATOR);
}

/** `code` → `android_code`. Already-qualified names are returned unchanged. */
export function qualifyAgentName(profileId: string, name: string): string {
  return isQualifiedAgentName(name, profileId) ? name : `${profileId}${SEPARATOR}${name}`;
}

/**
 * Whether a reported agent satisfies a list of allowed names.
 *
 * The reported name may arrive bare (`code`) or qualified (`android_code`);
 * both are accepted for the owning profile. A name qualified by a *different*
 * profile never matches, so profiles stay isolated.
 */
export function agentIsAllowed(
  agent: string,
  allowed: readonly string[],
  profileId: string
): boolean {
  if (allowed.length === 0) return true;
  const candidates = new Set([agent, qualifyAgentName(profileId, agent)]);
  return allowed.some((entry) => candidates.has(qualifyAgentName(profileId, entry)));
}
