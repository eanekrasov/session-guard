export function isInvariantsPass(session: {
  gates?: Array<{ id: string; status: string }>;
}): boolean {
  return session.gates?.find((g) => g.id === 'invariants')?.status === 'pass';
}

export function mutationOutputReady(session: {
  activeOperations?: Array<{ result?: string }>;
}): boolean {
  // A session holds a map of open calls, exposed to guards as an array
  // (`toSessionFacts`). `activeMutation` was a single object and is not a
  // field of the session schema.
  return (session.activeOperations ?? []).some((o) => o.result === 'output_ready');
}
