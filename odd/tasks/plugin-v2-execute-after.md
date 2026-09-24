# ODD Task Tracker: V2 Execute-After Integration

## Objective

Implement the authorized V2 Phase 4 `execute.after` slice: adapt completed and failed V2 tool
events to the shared Session Guard after-execution lifecycle while preserving V1 compatibility.

## Problem

The current V2 adapter registers only `execute.before`. The installed V2 hook declaration exposes
an `execute.after` discriminated union, while the V1 runtime expects a V1-shaped completed output.
Without an explicit adapter, completed operations cannot reliably finish and failed operations may
remain pending or be misrepresented as successes.

## Why This Slice

Phase 3 proves V2 before-policy admission. Phase 4 is the next authorized lifecycle boundary and
must close the operation started by an admitted call without duplicating the shared policy/runtime.

## Authorized Scope

- Register `ctx.tool.hook('execute.after', ...)` through the existing V2 adapter.
- Add the smallest host-neutral result/error projection and runtime-facing lifecycle changes needed
  to close V2 operations.
- Add focused tests and update the V2 capability matrix only after behavioral proof.
- Preserve V1 behavior and both supported entrypoints.

## Constraints

- Reuse the existing Session Guard runtime; do not create a second lifecycle or policy engine.
- Do not fabricate a V1 `PluginInput`, V1 `Context`, or V1 client for V2.
- Preserve tool, session, call, and raw input identity exactly; do not substitute missing or stale
  call IDs with generated values.
- Preserve V2 `agent` and `messageID` from every event registration and mapping.
- Sanitize only the output made available to the runtime; do not mutate or expose an unsanitized
  V2 result object as a V1 output shape.
- Keep V1 hook behavior and public entrypoints compatible.
- Do not alter unrelated source, tests, generated files, or other task trackers/implementation
  plans.
- Technical artifacts must remain in English.

## Verified Installed V2 Result/Error Semantics

`node_modules/@opencode/plugin/dist/promise/tool.d.ts` declares `execute.after` with required
`tool`, `sessionID`, `agent`, `messageID`, `id`, and `input`, plus this discriminated union:

- `status: 'completed'` with `result: Tool.Result`;
- `status: 'error'` with `error: Tool.Error`.

`node_modules/@opencode/schema/dist/tool.d.ts` declares `Tool.Result` as optional `output`,
`content`, and `metadata`; `Tool.Error` has `message`, optional `error`, and optional `metadata`.
The adapter must explicitly map this installed union. A completed event may invoke completed-output
processing using only safely representable/sanitized fields. An error event must use an explicit
failure lifecycle path that closes the matching operation and records the failure context; it MUST
NOT fabricate a successful V1 result, run success-only observation/result processing, or claim
success merely to reuse the V1 callback.

## Stable Actionable Checklist

- [x] V2A-001 Reconfirm the installed V2 `execute.after` declaration and `Tool.Result` / `Tool.Error`
      fields from local declarations before implementation; record the exact mapping in code/tests.
- [x] V2A-002 Inventory the shared V1 after lifecycle, including mutation finish, workflow-result
      processing, and its assumptions about successful output.
- [x] V2A-003 Define the smallest host-neutral V2 after-event/result projection, reusing existing
      types where their semantics match.
- [x] V2A-004 Register exactly one V2 `execute.after` hook and retain it with the existing before
      registration for idempotent cleanup.
- [x] V2A-005 Map completed events with tool, session, call, raw input, agent, messageID, and only
      sanitized available result output/metadata.
- [x] V2A-006 Map error events through an explicit failure lifecycle that closes the matching
      operation without fabricating success or invoking success-only processing.
- [x] V2A-007 Treat missing or stale call identity as a safe no-op/diagnostic according to verified
      runtime semantics; never close or mutate another operation.
- [x] V2A-008 Ensure a successful V2 after event closes its matching active operation and completes
      all applicable shared lifecycle work.
- [x] V2A-009 Ensure a failed V2 after event closes its matching active operation and records its
      failure outcome without leaving it pending.
- [x] V2A-010 Preserve V1 after-hook behavior, including V1 output handling and lifecycle closure.
- [x] V2A-011 Add focused tests proving completed-result mapping, output sanitization, identity
      preservation, and success lifecycle closure.
- [x] V2A-012 Add focused tests proving error lifecycle handling never fabricates success and leaves
      no matching operation pending.
- [x] V2A-013 Add focused tests for missing and stale call identity, including no cross-operation
      mutation.
- [x] V2A-014 Add a focused unrelated-session test proving a V2 after event cannot close or mutate
      another session's operation.
- [x] V2A-015 Add cleanup coverage for two registrations: both registrations dispose exactly once,
      partial second-registration failure disposes the first, and disposal failures retain the
      established error behavior.
- [x] V2A-016 Update the V2 capability matrix from `out-of-scope` only after the completed and error
      behavior above is proven; retain a precise reason for every deferred capability.
- [x] V2A-017 Run focused V2 adapter/contract tests and record each exact command and result below.
- [x] V2A-018 Run `mise run check`, `mise run build`, and `mise run smoke`; record any external
      blocker honestly rather than claiming host proof.
- [x] V2A-019 Inspect generated `dist/` changes after the build and confirm generated output was not
      edited manually.
- [x] V2A-020 Review the final diff, run `git diff --check`, state the rollback boundary, and create
      one conventional work-unit commit containing only this behavior, tests, capability evidence,
      tracker, and generated build output if any.

## Acceptance Criteria

1. V2 registers `ctx.tool.hook('execute.after', ...)` and maps the installed completed/error union
   explicitly.
2. Completed events preserve tool/session/call/raw-input identity plus `agent` and `messageID`, and
   expose only sanitized available output to the shared runtime.
3. Error events never fabricate successful V1 output or trigger success-only result handling.
4. Both successful and failed matching calls close their lifecycle; neither leaves an operation
   pending.
5. Missing/stale call IDs and unrelated sessions cannot close or mutate a different operation.
6. Both V2 registrations clean up exactly once, including partial setup and disposal failure paths.
7. V1 behavior remains compatible and regression coverage is green.
8. The capability matrix is updated only after executable evidence proves V2 after behavior.

## Exact Checks

```bash
bun test test/app/plugin-v2-contract.test.ts test/app/v2-plugin-adapter.test.ts
mise run check
mise run build
mise run smoke
git diff --check
```

If implementation splits the focused coverage, run every relevant test file and record each exact
command. `mise run smoke` remains required for this host-integration slice; an unavailable external
prerequisite is a blocker, not evidence of success.

## Advisory Review Workload Forecast

| Field                     | Forecast                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated authored change | Approximately 400 lines across adapter, lifecycle projection, tests, and capability evidence                                             |
| Review-budget status      | At the advisory threshold; count authored additions and deletions before committing                                                      |
| Delivery strategy         | `ask-on-risk`                                                                                                                            |
| Expected work unit        | One cohesive V2 execute-after lifecycle slice with its tests and tracker evidence                                                        |
| Risk driver               | Explicit error closure may expose V1 success-only assumptions or require a narrow runtime seam                                           |
| Escalation trigger        | More than 400 authored changed lines, a second independent behavior, or broad V1 lifecycle migration                                     |
| Escalation action         | Stop before commit and ask whether to split at the smallest independent adapter/lifecycle boundary or accept a documented size exception |
| Generated output          | Excluded from authored estimate but included in build verification and complete diff review                                              |

This forecast is advisory only. It does not permit compressing code, deleting tests, or concealing
required documentation to fit the budget.

## Progress Evidence

- Status: complete; work-unit commit created.
- Completed checklist items: V2A-001 through V2A-020.
- Focused tests: `bun test test/app/plugin-v2-contract.test.ts test/app/v2-plugin-adapter.test.ts`
  passed: 12 tests, 26 expectations, 0 failures.
- Type verification: `mise run typecheck` passed.
- Full checks: `mise run check` passed: 1812 tests, 3908 expectations, 0 failures.
- Build/generated-output inspection: `mise run build` passed; `git diff -- dist` and
  `git status --short -- dist` were empty, confirming no generated output was edited manually.
- Host smoke: `mise run smoke` was attempted and blocked before plugin execution because the temporary
  configuration references missing `~/.secrets/crpt-ai`. The host reported `bad file reference`; this
  is an external prerequisite and not V2 behavior evidence.
- Final diff check: `git diff --check` passed with the final tracker evidence.
- Rollback boundary: the V2 after adapter/contract, narrow failure lifecycle operation, focused tests,
  capability matrix, tracker, and generated output (none changed).
- Work-unit commit: `nny` (`feat(plugin): complete V2 execute-after lifecycle`).

## Next Step

Repair the external smoke prerequisite and rerun `mise run smoke` to obtain host integration proof.
