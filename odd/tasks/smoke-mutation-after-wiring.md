# Smoke Mutation After-Wiring

## Objective

Restore the mutation finalization path the runtime lost in `5bc3cfa`, so a successful
`write`/`edit`/`bash` records its verdict and releases its lock, and make the host-smoke runner
survive writing its report when `docs/plans` does not exist yet.

## Problem

`host-smoke` cannot pass `commit-cwd` or `commit-mismatch` regardless of the model:

- `toolExecutionPolicy.after` is never called (`runtime.ts` calls only `.before`), and
  `createToolExecutionPolicy(...)` never receives `changeAfterInput`, so
  `changeEnforcement.after` → `MutationOrchestrator.finishMutation` is unreachable.
- A successful mutation therefore never writes `run.checks`/`session.checks`
  (`no run reports passing checks (got [null])`) and never deletes its active operation, so the
  next mutating call is refused with `Mutation failed: Active operation already exists: <callId>`
  for up to `MUTATION_TTL_MS` (30 minutes).
- Independently, the runner `writeFile`s `docs/plans/host-smoke.md` without creating the parent
  directory. `docs/plans` is gitignored and absent, so the run dies with `ENOENT` after the
  scenarios, losing the report and turning a passing scenario into a non-zero exit.

## Scope

- `src/app/runtime.ts`: supply `changeAfterInput` and invoke `toolExecutionPolicy.after` in the
  `tool.execute.after` path, in the position the pre-regression code used (after consent, before
  transitions).
- `scripts/host-smoke/report.ts` (new): `writeSmokeReport` creates the report's parent directory.
- `scripts/host-smoke/run.ts`: write the report through the new helper.
- Regression coverage for the after-hook wiring and for the report writer.
- Live V2 confirmation is a separate decision and is **not** claimed here.

## Constraints

- No behavior change beyond restoring the lost call and the report directory: the verdict, scope,
  invariant and release logic stay exactly where they already live.
- Do not touch profiles, schemas, or the V2 adapter.
- No remote operations, push, or PR.
- `dist/` changes come only from `mise run build`.

## Stable Task IDs

- `MAW-001`: Record the root cause and this task artifact.
- `MAW-002`: Restore the after-hook wiring in `runtime.ts`.
- `MAW-003`: Create the report directory before writing the smoke report.
- `MAW-004`: Add regression coverage for both fixes.
- `MAW-005`: Run the required checks and report the receipt honestly.

## Acceptance Criteria

1. A successful mutating tool call through `tool.execute.after` deletes its active operation and
   records a verdict on the task run (or the session, outside a loop).
2. The `tool.execute.after` order stays: guardrails → rules → settler → commit permit → consent →
   mutation finalization → transitions.
3. `writeSmokeReport` creates missing parent directories and writes the report; a missing
   `docs/plans` no longer fails a run.
4. New tests fail against the pre-fix code and pass after it.
5. `mise run check` and `mise run build` pass; `git diff -- dist` is empty.

## Checks

- `bun test test/app/mutation-after-wiring.test.ts test/app/host-smoke-report.test.ts`
- `mise run check`
- `mise run build`
- `git diff --check`
- `git diff -- dist`

## Progress

- [x] `MAW-001` Root cause established: `5bc3cfa` (2026-09-18) removed
      `await this.mutationAfter(...)` from `runtime.ts` and added `tool-execution-policy.ts`
      without wiring its `after`; `changeAfterInput` is not supplied either. Only
      `handleToolFailure` (error paths) and the 30-minute TTL ever release a lock.
- [ ] `MAW-002` Pending.
- [ ] `MAW-003` Pending.
- [ ] `MAW-004` Pending.
- [ ] `MAW-005` Pending.

## Evidence and Decisions

- Root cause, with `file:line` evidence, is recorded in the session that produced this document;
  the short form is in `## Problem`.
- `runtime.ts:403-405` already claims the work "is handled by changeEnforcement in
  toolExecutionPolicy" — the call site was simply never added, so this change restores the stated
  intent rather than inventing a new design.
- Pre-regression ordering taken from `5bc3cfa^:src/app/runtime.ts` (mutation finalization
  immediately before `transitionAfter`).
- Unit tests stayed green because `test/app/mutating-tools.test.ts` covers only the _before_
  refusal and `test/app/runtime.test.ts`'s "mutation finalization" block asserts no-op cases only.

## Mirror State

Pending full-document mirror to Engram topic `odd/smoke-mutation-after-wiring/tasks`: `mem_save`
is currently refused because several active runtime sessions match this checkout and no session
id is registered. The exact current task state remains this file.
