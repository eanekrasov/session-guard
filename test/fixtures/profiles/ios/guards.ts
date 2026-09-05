export function isInvariantsPass(session: {
  gates?: Array<{ id: string; status: string }>;
}): boolean {
  return session.gates?.find((g) => g.id === 'invariants')?.status === 'pass';
}

export function mutationOutputReady(session: {
  activeMutation?: { outputReady?: boolean };
}): boolean {
  return session.activeMutation?.outputReady === true;
}
