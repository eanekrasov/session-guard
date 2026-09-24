# ODD Task Tracker: V2 Phase 5 Parent Resolution

## Objective

Implement the authorized V2 Phase 5 parent-resolution sub-slice: resolve a V2 host session to
its workflow root through a narrow, host-neutral parent resolver port.

## Problem

The shared runtime currently resolves parent relationships through the V1 client contract. V2
exposes a different session-get argument and result shape, so reusing the V1 adapter or client
would couple the V2 entrypoint to an incompatible host API and risk incorrect root selection.

## Why This Slice

Child sessions must map to the workflow state owned by their root session. This is the next
unproven V2 capability after the tool lifecycle slices and is deliberately limited to parent
resolution rather than broader V2 host parity.

## Authorized Scope

- Introduce only the host-neutral parent resolver port and the smallest V2 adapter needed to
  provide it.
- Connect the V2 resolver to existing root resolution without changing V1 behavior.
- Add focused behavioral tests and update the V2 capability state only after proof.
- Do not modify source, tests, generated output, the existing untracked plan, or unrelated ODD
  trackers as part of creating this tracker.

## Verified Host Contract

The installed V2 package declares `SessionDomain` as including `SessionApi.get`. Its promise
client declaration types this operation as:

```ts
ctx.session.get(input: SessionGetInput, requestOptions?): Promise<SessionInfo>
```

`SessionGetInput` is `{ sessionID: string }`. `SessionInfo` has an optional `parentID?: string`.
The V2 lookup argument is the typed object `{ sessionID }`, and its successful result is the
`SessionInfo` object itself.

V1 uses a different request/result shape: its generated `SessionGetData` accepts
`{ path: { id: string }, query?: { directory?: string } }` and returns a request result whose
successful session is exposed through the V1 response/result wrapper. V2 MUST NOT reuse that V1
request or result contract.

## Constraints

- Introduce only a host-neutral parent resolver port; keep host-specific API details in the V1
  and V2 adapters.
- Do not fabricate a V1 client or a V1 `PluginInput` for V2.
- Do not add workflow tool transform/adaptation or event subscription work to this slice.
- Treat an empty, absent, or otherwise missing `parentID` as self-rooting.
- A rejected or failed lookup is not evidence that a session is a root: do not cache that fallback
  and do not cross-mutate another session while resolving it.
- Preserve existing V1 parent-resolution behavior and entrypoint compatibility.
- Change the capability state only after executable proof, not after declaration inspection.
- Technical artifacts remain in English.

## Stable Actionable Checklist

- [x] V2P-001 Reconfirm the installed V2 `ctx.session.get({ sessionID })` declaration, its
      `Promise<SessionInfo>` result, and optional `SessionInfo.parentID` before implementation.
- [x] V2P-002 Reconfirm the V1 session-get request/result contract and isolate it from the V2
      adapter rather than assuming the shapes are interchangeable.
- [x] V2P-003 Inventory current root resolution, parent caching, transaction ownership, and V1
      resolver behavior before extracting any seam.
- [x] V2P-004 Define the smallest host-neutral parent resolver port returning `Promise<string |
null>`; reuse existing domain types where their semantics match.
- [x] V2P-005 Adapt V2 `ctx.session.get` with the exact `{ sessionID }` input object and project
      only a non-empty string `parentID` into the port.
- [x] V2P-006 Treat an absent, empty, or missing V2 `parentID` as the queried session's own root.
- [x] V2P-007 Resolve multiple parent hops to one root and memoize successful traversed mappings
      so repeated child or intermediate lookups avoid redundant host calls.
- [x] V2P-008 On a rejected lookup, preserve retryability: do not cache a false root and do not
      mutate, save, or queue work under another session's root.
- [x] V2P-009 Prove a V2 child maps to its declared root and the V2 call receives exactly the
      `{ sessionID: childSessionID }` input object.
- [x] V2P-010 Prove a V2 root maps to itself when `parentID` is absent or empty.
- [x] V2P-011 Prove multi-hop V2 parent resolution and successful cache reuse for child and
      intermediate IDs.
- [x] V2P-012 Prove a rejected V2 lookup is retried and cannot establish a cached false root.
- [x] V2P-013 Prove session isolation: resolving or failing one session cannot load, mutate, save,
      queue, or otherwise affect an unrelated workflow session.
- [x] V2P-014 Add V1 regression coverage proving its distinct request/result adapter and existing
      root behavior remain compatible.
- [x] V2P-015 Update the V2 capability matrix from `to verify` only after the behavioral tests
      above pass; retain precise reasons for any remaining deferred capability.
- [x] V2P-016 Run focused V2 parent-resolution and V1 regression tests; record every exact command
      and result below.
- [x] V2P-017 Run `mise run check` and `mise run build`; inspect `dist/` after the build and do not
      edit generated output manually.
- [x] V2P-018 Run `mise run smoke` for this host-integration change, or document its external
      prerequisite/blocker honestly without claiming host proof.
- [x] V2P-019 Review the final diff, run `git diff --check`, state the rollback boundary, and create
      one conventional work-unit commit containing only this slice and its evidence.

## Acceptance Criteria

1. V2 obtains parent information exclusively through a host-neutral resolver port backed by
   `ctx.session.get({ sessionID })`.
2. A V2 child resolves to the declared root; a root with absent or empty `parentID` resolves to
   itself.
3. V2 parent lookup receives the exact `{ sessionID }` input object, never a V1-shaped request
   object.
4. Multi-hop chains resolve to one root and successful results are cached without redundant calls.
5. Lookup rejection never creates a cached false root or causes cross-session mutation.
6. V1 retains its existing, distinct parent lookup behavior and regression tests pass.
7. The capability matrix changes only after executable proof.

## Exact Checks

```bash
bun test test/app/plugin-v2-contract.test.ts test/app/v2-plugin-adapter.test.ts
mise run check
mise run build
mise run smoke
git diff --check
```

The implementation may add or split focused parent-resolution tests; run every relevant test file
and record each exact command. `mise run smoke` requires a working external OpenCode host
configuration. If its prerequisite is unavailable, record the blocker; it is not host proof.

## Advisory Review Workload Forecast

| Field                     | Forecast                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Estimated authored change | Approximately 400 lines across the V2 adapter, host-neutral port, focused tests, and capability evidence                            |
| Review-budget status      | Advisory threshold; count authored additions and deletions before committing                                                        |
| Delivery strategy         | `ask-on-risk`                                                                                                                       |
| Expected work unit        | One cohesive V2 parent-resolution slice with its V1 regression coverage and tracker evidence                                        |
| Risk driver               | A narrow port may expose hidden V1 request/result coupling or parent-cache failure semantics                                        |
| Escalation trigger        | More than 400 authored changed lines, a second independent host capability, or a broad V1 migration                                 |
| Escalation action         | Stop before commit and ask whether to split at the smallest independent adapter/port boundary or accept a documented size exception |
| Generated output          | Excluded from authored estimate but included in build verification and complete diff review                                         |

This forecast is advisory only. It does not permit compressing code, deleting tests, or omitting
required evidence to fit the budget.

## Progress

- Status: complete.
- Completed checklist items: V2P-001 through V2P-019.
- Blocked items: host smoke is externally blocked before plugin execution by missing
  `~/.secrets/crpt-ai`.
- Work-unit commit: pending creation.

## Evidence

- Contract inspection: `@opencode/plugin` `SessionDomain.get` was verified as
  `get(input: SessionGetInput, requestOptions?)`, with `SessionGetInput` equal to
  `{ sessionID: string }` and a direct `SessionInfo` result. The previous literal-string claim was
  corrected before implementation. V1 remains `{ path: { id } }` with `result.data.parentID`.
- Focused tests: `bun test test/app/plugin-v2-contract.test.ts test/app/v2-plugin-adapter.test.ts
test/app/session-executor.test.ts` passed: 35 tests, 89 expectations, 0 failures.
- V1 regression: included in the focused command; the executor test verifies its distinct
  `{ path: { id } }` request and `result.data.parentID` projection.
- Typecheck: `mise run typecheck` passed.
- Full checks: `mise run check` passed: 1818 tests, 3927 expectations, 0 failures.
- Build and generated-output inspection: `mise run build` passed; `git diff -- dist` and
  `git status --short -- dist` were empty.
- Host smoke: `mise run smoke` was attempted but blocked before plugin execution because the
  temporary host configuration references missing `~/.secrets/crpt-ai` (`bad file reference`).
  This external prerequisite is not host behavior proof.
- Final diff check: `git diff --check` passed. The final diff contains only the V2 parent adapter,
  host-neutral resolver injection, focused V1/V2 tests, capability evidence, and this tracker.
- Rollback boundary: remove the resolver injection in `src/app/runtime.ts`, the V2 projection in
  `src/app/v2-plugin-contract.ts` and `src/app/v2-plugin-adapter.ts`, their focused tests, and this
  tracker. No generated output changed.
