# ODD Task Tracker: V2 Execute-Before Integration

## Objective

Implement the next authorized slice of the V2 plugin plan: make V2
`execute.before` enforce the existing Session Guard before-execution policy through an explicit
host adapter.

## Problem

The current V2 adapter registers `ctx.tool.hook('execute.before')`, but it forwards only tool,
session, call, and input data to V1-shaped hooks. It still relies on an unsafe V2-to-V1 client
cast, does not prove rejection propagation, and drops V2 `agent` and `messageID` even though the
V2 event contract declares them.

## Why This Slice

V2 Phase 1 and Phase 2 established a narrow contract and shared runtime construction. The next
unresolved planned slice is Phase 3. It is the first V2 behavior boundary where a registration
must prove policy enforcement rather than merely prove setup and cleanup.

## Authorized Scope

- Implement only V2 `execute.before` event adaptation and its narrowly required runtime-facing
  contract changes.
- Remove the unsafe V2-to-V1 client cast used by the V2 adapter.
- Do not create a fake V1 `PluginInput` to make V2 work.
- Preserve V1 behavior and entrypoint compatibility.
- Add focused unit or integration tests for V2 registration, forwarding, blocking, allowing, and
  session isolation.
- Update the V2 capability matrix and this tracker only when evidence supports the update.

## Constraints

- Reuse the existing application policy/runtime; do not create a second policy engine.
- Keep host APIs at the V2 adapter seam. Runtime-facing contracts must be narrower than either
  V1 `PluginInput` or V2 `Context`.
- Preserve V2 `agent` and `messageID` whenever the installed host event contract supports them.
- Preserve raw input, tool name, host session ID, call ID, and host-supported rejection semantics.
- A blocked operation must remain blocked through the V2 hook; logging alone is not enforcement.
- Do not claim Phase 3 is complete until blocked, allowed, and unrelated-session behavior is
  proven by executable evidence.
- Do not infer unsupported host semantics. Record unavailable behavior explicitly in the
  capability matrix and tests.
- Keep all technical artifacts in English.
- Do not modify unrelated source, tests, generated output, or the untracked implementation plan.

## Resolved Next Slice

**V2 Phase 3 — Implement `execute.before`** from
[`docs/plugin-v2-implementation-plan.md`](../../docs/plugin-v2-implementation-plan.md),
following the Phase 3 exit criteria: a V2 before hook blocks a disallowed operation, allows an
allowed operation, and does not affect unrelated sessions.

## Stable Actionable Checklist

- [x] V2B-001 Confirm the installed V2 `execute.before` callback declaration, event payload, and
      rejection mechanism from local type declarations and a minimal runtime-compatible test seam.
- [x] V2B-002 Inventory the current V1 before-operation input/output fields consumed by the shared
      runtime and identify the smallest host-neutral projection.
- [x] V2B-003 Define or refine the internal V2 before-event adapter contract without duplicating
      existing session or tool DTOs.
- [x] V2B-004 Remove the unsafe `Context.session` to V1-client cast from the V2 construction path.
- [x] V2B-005 Ensure V2 construction uses only the host-neutral dependencies actually required for
      this slice; do not fabricate a V1 `PluginInput`.
- [x] V2B-006 Map V2 tool name, session ID, call ID, raw input, `agent`, and `messageID` into the
      runtime-facing before operation when the host supplies them.
- [ ] V2B-007 Preserve optional identity fields as absent when the host contract omits them; do not
      invent sentinel values that alter policy semantics.
- [x] V2B-008 Propagate a policy rejection through the host-supported V2 hook path rather than
      converting it to a diagnostic-only result.
- [x] V2B-009 Keep V1 hook assembly and V1 behavior unchanged except for a shared, host-neutral
      contract extraction that is demonstrably behavior-preserving.
- [x] V2B-010 Add a focused V2 adapter test that verifies one `execute.before` registration and
      cleanup of that registration.
- [x] V2B-011 Add a focused V2 test proving a disallowed operation is blocked through the V2 hook.
- [x] V2B-012 Add a focused V2 test proving an allowed operation is forwarded and remains allowed.
- [x] V2B-013 Add a focused V2 test proving an event for one session does not mutate or block an
      unrelated session.
- [x] V2B-014 Add assertions that `agent` and `messageID` survive adaptation when provided by the
      installed V2 host contract.
- [ ] V2B-015 Add an absent-optional-fields case if the installed contract permits optional
      `agent` or `messageID`.
- [x] V2B-016 Update the V2 capability matrix from `out-of-scope` only after the above behavior is
      verified; retain precise reasons for deferred capabilities.
- [x] V2B-017 Run the focused V2 test file(s), record the exact command and result below, and fix
      only failures attributable to this slice.
- [ ] V2B-018 Run `mise run check`, `mise run build`, and `mise run smoke` because this changes
      runtime and host integration; record exact results below.
- [x] V2B-019 Inspect generated `dist/` changes after the build and confirm that generated output
      was produced by the build rather than edited manually.
- [x] V2B-020 Review the final diff for scope, run `git diff --check`, and record the rollback
      boundary: V2 before adapter, its host-neutral contract, its tests, and generated build output.
- [x] V2B-021 Create one conventional work-unit commit containing the adapter behavior, focused
      tests, capability-matrix update, and required build output; do not include unrelated work.

## Acceptance Criteria

1. V2 registers `ctx.tool.hook('execute.before', ...)` through an explicit adapter.
2. The adapter reaches the shared before-execution policy without casting V2 `Context` to a V1
   input shape and without fabricating `PluginInput`.
3. The adapter preserves tool name, session ID, call ID, raw input, and host-supported `agent` and
   `messageID`.
4. A policy-blocked V2 operation is rejected via the host-supported hook path.
5. A policy-allowed V2 operation proceeds through the adapter.
6. A V2 event for a different session does not affect the target session's policy state.
7. V1 regression coverage remains green.
8. The capability matrix marks only behavior supported by tests as supported.

## Checks

```bash
bun test test/app/plugin-v2.test.ts
mise run check
mise run build
mise run smoke
git diff --check
```

If the focused V2 test file is split during implementation, run each relevant file and record
every command exactly. `mise run smoke` is required for this host-integration slice; if it cannot
run because of an external prerequisite, record the blocker rather than claiming host proof.

## Advisory Review Workload Forecast

| Field                     | Initial forecast                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated authored change | Approximately 400 lines across adapter, host-neutral contract, tests, and capability matrix                                                  |
| Review-budget status      | At the advisory threshold; measure authored additions and deletions before commit                                                            |
| Delivery strategy         | `ask-on-risk`                                                                                                                                |
| Expected work unit        | One cohesive V2 execute-before behavior slice, with its tests and capability evidence                                                        |
| Likely risk driver        | Contract extraction may expose more V1 client coupling than Phase 1/2 characterization captured                                              |
| Escalation trigger        | If a cohesive implementation exceeds 400 authored changed lines, requires a second independent behavior, or needs broad V1 runtime migration |
| Escalation action         | Stop before committing and ask whether to split at the smallest independent adapter/contract boundary or accept a documented size exception  |
| Generated output          | Excluded from the authored review estimate but included in build verification and full diff review                                           |

This is an advisory forecast, not permission to compress code, delete tests, or hide necessary
documentation to fit a line target.

## Progress

- Status: implementation complete; verification complete except host smoke, which is externally blocked.
- Completed checklist items: V2B-001 through V2B-006, V2B-008 through V2B-014, and V2B-016 through V2B-017,
  V2B-019, and V2B-020.
- Not applicable: V2B-007 and V2B-015. Installed V2 declarations require `agent` and `messageID`.
- Blocked items: none recorded.

## Verification Evidence

- Plan source reviewed: `docs/plugin-v2-implementation-plan.md`, Phase 3.
- Adapter evidence: `src/app/v2-plugin-adapter.ts` maps the registered V2 event through
  `v2ToolBeforeEvent` without V2-to-V1 client casting and forwards identity plus raw input.
- Contract evidence: `src/app/v2-plugin-contract.ts` declares the V2 event identity and marks tool
  before policy supported after behavioral proof.
- Installed V2 declaration evidence: `node_modules/@opencode/plugin/dist/promise/tool.d.ts` defines
  `ctx.tool.hook('execute.before')` with `tool`, `sessionID`, `agent`, `messageID`, `id`, and `input`;
  the hook callback returns `Promise<void>`, so its rejection propagates to the host.
- Focused verification: `bun test test/app/plugin-v2-contract.test.ts
test/app/v2-plugin-adapter.test.ts` passed: 9 tests, 18 expectations, 0 failures.
- Type verification: `mise run typecheck` passed after the V2 host-neutral client projection.
- Full verification: `mise run check` passed: 1809 tests, 3900 expectations, 0 failures.
- Build verification: `mise run build` passed and reported all required outputs present and entrypoints distinct.
- Host smoke: `mise run smoke` was attempted but failed before plugin execution because its temporary
  OpenCode configuration refers to missing `~/.secrets/crpt-ai`; the harness reported
  `Configuration is invalid ... bad file reference`. This is an external local prerequisite, not
  evidence that the V2 registration or policy behavior failed.
- Generated output inspection: after `mise run build`, `git diff -- dist` and `git status --short -- dist`
  were empty; build output was produced by the task and created no tracked artifact diff.
- Final diff verification: `git diff --check` passed. Rollback boundary: the V2 before adapter,
  its host-neutral runtime projection, contract mapping, focused tests, tracker, and any generated
  build output (none changed).
- Work-unit commit: `msk` (`feat(plugin): enforce V2 execute-before policy`).

## Next Step

Repair the local smoke configuration prerequisite, then rerun `mise run smoke` before closing V2B-018.
