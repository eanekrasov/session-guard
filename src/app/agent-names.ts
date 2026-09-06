/**
 * Agent names as OpenCode sees them.
 *
 * `syncProfileAgents` copies `profiles/<id>/<agentsDir>/*.md` into
 * `.opencode/agents/<id>/`, and OpenCode derives an agent's name from the path
 * under `agent/` or `agents/`. A profile's `code.md` therefore registers as
 * `<id>/code`, never bare `code`.
 *
 * Schemas stay authored with bare names; resolution qualifies them so the
 * runtime can compare against what the host actually reports.
 */

/** True when the name already carries a profile prefix. */
export function isQualifiedAgentName(name: string): boolean {
  return name.includes('/');
}

/** `code` → `android/code`. Already-qualified names are returned unchanged. */
export function qualifyAgentName(profileId: string, name: string): string {
  return isQualifiedAgentName(name) ? name : `${profileId}/${name}`;
}

/**
 * Whether a reported agent satisfies a list of allowed names.
 *
 * The reported name may arrive bare (`code`) or qualified (`android/code`);
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
