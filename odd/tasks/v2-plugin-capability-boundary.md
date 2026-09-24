# V2 Plugin Capability Boundary

## Objective

Document the verified current V2 plugin capability boundary after the completed
`execute.before` and `execute.after` slices without extending V2 host behavior
or inferring unsupported V2 APIs.

## Problem

The V2 implementation plan still describes the entrypoint as a smoke-test stub
and contains a planned capability-matrix template. The source capability matrix
now records implemented mappings and deferred capabilities, but the plan does
not publish that verified state or require every matrix entry to be evidenced.

## Why

Consumers and future implementers need a single, checked description of what
V2 currently supports, what remains deferred, and why. This prevents accidental
claims of V1 parity or speculative host integration.

## Scope

- Update `docs/plugin-v2-implementation-plan.md` with verified current state
  and its single published capability matrix.
- Add a focused contract test that validates the source capability matrix has
  an existing test reference for each supported entry and an explicit reason
  for each deferred or out-of-scope entry.
- Record the completed documentation/evidence slice separately from remaining
  Phase 5 and Phase 7 work.

## Constraints

- Do not add V2 hooks, host events, chat processing, transforms, compaction,
  or tool surfaces.
- Do not assume unknown V2 APIs or manually edit generated output.
- Keep source artifacts in English.
- Do not claim V2 host smoke verification occurred.
- Preserve unrelated working-tree changes owned by other agents.

## Stable Tasks

- [x] V2-CB-01: Verify the source capability matrix, adapter behavior, and
      focused V2 tests.
- [x] V2-CB-02: Publish the verified current-state wording and capability
      matrix in the V2 plan.
- [x] V2-CB-03: Add contract evidence for every source capability entry.
- [x] V2-CB-04: Run focused tests and whitespace validation.
- [x] V2-CB-05: Record observed results and commit the bounded work unit.

## Acceptance Criteria

1. The V2 plan no longer calls the entrypoint a smoke-test stub and accurately
   distinguishes supported capabilities from deferred work.
2. The plan contains one concise current capability matrix with capability,
   V1 source, V2 mapping/status, reason for deferred/out-of-scope entries, and
   resolving test path.
3. A focused test verifies every source matrix capability either references an
   existing test or is explicitly deferred/out-of-scope with a reason.
4. Phase status distinguishes this completed documentation/evidence slice from
   remaining Phase 5 work and does not claim Phase 7 smoke verification.
5. No V2 host behavior or generated artifact changes.

## Checks

- `bun test test/app/plugin-v2-contract.test.ts`
- `bun test test/app/v2-plugin-adapter.test.ts`
- `git diff --check`

`mise run check` and `mise run build` are not required unless implementation
types or runtime sources change; this work unit is documentation and focused
test evidence only.

## Progress

Completed V2-CB-01 through V2-CB-04. The source matrix records the supported
shared runtime construction, `execute.before`, `execute.after`, workflow-list
transform, parent lookup, and cleanup. Host events, chat processing, compaction,
and message transform remain deferred with explicit reasons. Each supported
matrix entry now has a resolving test path; the contract test checks this
invariant.

Observed checks:

- `bun test test/app/plugin-v2-contract.test.ts` — 6 passed.
- `bun test test/app/v2-plugin-adapter.test.ts` — 12 passed.
- `mise run check` — 1,823 passed; 0 failed.
- `mise run build` — passed; `dist/` remained unchanged.
- `git diff --check` — passed.

Phase 7 V2 host smoke was not run and is not claimed. The next action is
the remaining Phase 5 mapping work, starting with installed-contract discovery
for a specific capability. The Engram mirror was saved as observation #1622
under `odd/v2-plugin-capability-boundary/tasks` for project `state-machine`.
