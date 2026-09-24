# ODD Task Tracker: V2 Custom Workflow Tool — Read-Only `workflow-list`

## Objective

Implement the first V2 custom workflow tool as a narrow, read-only `workflow-list` registration.
Reuse the existing workflow-profile listing behavior, expose it through the verified V2 tool
editor contract, and keep V1 behavior and all existing V2 slices unchanged.

## Problem

The V2 plugin still needs a proven custom-tool registration seam. `workflow-list` is the smallest
safe first tool because it reads available profiles and does not require a workflow session,
mutation, consent, task control, or event integration. The implementation must not reuse the V1
`ToolDefinition`: V1 uses Zod input schemas, Promise-based execution, and a V1-shaped context,
whereas V2 requires a V2 `Tool.ValueSchema`, an Effect-returning `Tool.Info.execute`, and the
smaller V2 `ToolContext`.

## Why This Slice

This is the first V2 custom workflow tool and establishes registration, result mapping, reverse
cleanup, and read-only isolation without widening scope to unrelated tools or events. It should
prove the V2 host seam before any session-bound or mutating tool is considered.

## Authorized Scope

- Add only the V2 custom `workflow-list` tool.
- Extract or reuse the existing workflow-list behavior without duplicating its observable logic.
- Register the tool through `ctx.tool.transform(callback)` and retain the returned registration.
- Map the read-only result into the V2 `Tool.Result` contract.
- Prove successful, empty, and error outcomes.
- Prove reverse cleanup and isolation from unrelated sessions/projects.
- Update capability state only after executable evidence supports it.
- Do not add other V2 tools, tool events, event subscriptions, or workflow mutations.
- Do not modify `docs/plugin-v2-implementation-plan.md` or existing ODD trackers.
- Do not edit generated output manually; no source/test/generated changes outside this work unit's
  authorized implementation and focused tests.
- Keep all technical artifacts in English.

## Verified V2 Contract

The installed declarations were inspected before this tracker was created:

- `ctx.tool.transform(callback)` is the V2 transform registration API. The declaration returns a
  `Promise<Registration>` (the resolved registration is `Registration`), and each registration has
  `dispose(): Promise<void>`.
- The transform callback receives a `ToolEditor`; `ToolEditor.add` requires a V2 `Tool.Info`.
- V2 tool input is a `Tool.ValueSchema` (`Schema.Codec`, Standard Schema, or JSON Schema). This
  no-input tool must still provide a valid V2 schema, such as JSON Schema `{ type: 'object',
properties: {}, additionalProperties: false }`.
- V2 `Tool.Info.execute` returns `Effect.Effect<Tool.Result, Tool.Error>`, not a Promise and not a
  V1 tool result. The V2 `Tool.Result` may contain `output`, `content`, and `metadata`.
- V2 `ToolContext` contains only `sessionID`, `agent`, `messageID`, `id`, and `progress`.
  `workflow-list` must not expect V1 context fields or invent additional context fields.

## V1 Reuse Boundary

Direct V1 `ToolDefinition` reuse is forbidden. The V1 definition is built with Zod arguments,
returns a Promise, and receives a V1 context; those contracts are not assignable to V2's
`Tool.Info`, V2 `Tool.ValueSchema`, Effect result/error channel, or V2 `ToolContext`. Reuse the
underlying profile-listing application behavior only through a host-neutral extraction or a
shared function whose contract does not mention either host generation. Do not cast V1 types into
V2 types and do not fabricate a V1 context.

## Stable Actionable Checklist

- [x] V2L-001 Verify the installed `ctx.tool.transform` declaration, resolved `Registration`, and
      disposal contract from local declarations before source changes.
- [x] V2L-002 Verify `ToolEditor.add` requires `Tool.Info`, including the V2 input-schema and
      execute-result requirements.
- [x] V2L-003 Verify the exact V2 `Tool.ValueSchema`, `Tool.Result`, `Tool.Error`, and
      `ToolContext` declarations; record any relevant limitation here.
- [x] V2L-004 Inventory the existing V1 `workflow-list` behavior and identify the smallest
      host-neutral application extraction; confirm no duplicate behavior is introduced.
- [x] V2L-005 Implement the V2 no-input schema and `Tool.Info` declaration without reusing or
      casting the V1 `ToolDefinition`.
- [x] V2L-006 Implement V2 `execute` with the verified Effect success/error contract and only the
      V2 `ToolContext` fields actually needed by this read-only tool.
- [x] V2L-007 Map non-empty profile listings to a stable V2 `Tool.Result` while preserving the
      existing user-visible listing semantics.
- [x] V2L-008 Prove an empty profile directory returns the documented empty-list result rather
      than throwing or fabricating a profile.
- [x] V2L-009 Prove profile-listing errors map to `Tool.Error` with actionable context and do not
      report a successful result.
- [x] V2L-010 Register exactly one `workflow-list` tool through `ctx.tool.transform` and retain
      the returned registration for cleanup.
- [x] V2L-011 Prove reverse cleanup removes the V2 tool and does not leave a stale registration.
- [x] V2L-012 Prove cleanup is idempotent and safe when setup or registration fails partway through.
- [x] V2L-013 Prove invoking `workflow-list` is read-only and does not load, mutate, save, or
      queue workflow session state.
- [x] V2L-014 Prove an invocation for one session cannot affect an unrelated session.
- [x] V2L-015 Prove one plugin instance/project cannot read from or alter another project instance's
      tool state or profile source.
- [x] V2L-016 Run before/after regression checks proving V1 behavior and existing V2 slices remain
      unchanged; record exact evidence below.
- [x] V2L-017 Update the V2 capability matrix only after the focused behavior and cleanup proof;
      leave unrelated tools/events explicitly out of scope.
- [x] V2L-018 Run focused tests, full checks, typecheck, build, host smoke, and final diff checks;
      inspect generated output and record exact results below.
- [ ] V2L-019 Create one conventional work-unit commit containing only this `workflow-list` slice,
      its tests/evidence, and any build output produced by the required build.

## Acceptance Criteria

1. V2 registers exactly one read-only `workflow-list` custom tool through `ctx.tool.transform`.
2. The registration supplies a valid V2 `Tool.Info`, V2 `Tool.ValueSchema`, Effect-returning
   execute function, and V2-compatible success/error results.
3. The implementation reuses extracted application behavior without directly reusing or casting a
   V1 `ToolDefinition`, Zod schema, Promise execution contract, or V1 context.
4. Non-empty, empty, and error profile-listing outcomes are deterministic and tested.
5. Reverse cleanup disposes the registration exactly once, including partial setup failure.
6. The tool performs no session mutation and cannot cross session or project boundaries.
7. Existing V1 behavior and existing V2 behavior remain regression-tested and unchanged.
8. Capability status is updated only after proof; other V2 tools/events remain out of scope.

## Exact Checks

```bash
bun test <focused-v2-workflow-list-test-files>
bun test <focused-v2-workflow-list-test-files> <existing-v2-regression-test-files>
mise run typecheck
mise run check
mise run build
mise run smoke
git diff --check
git diff -- dist
git status --short -- dist
```

Replace placeholders with the exact test paths used. `mise run smoke` is required for this host
integration change; if an external prerequisite blocks it, record the blocker and do not claim
host proof. After the build, confirm generated output was produced by the build and not edited
manually.

## Advisory Review Workload Forecast

| Field                     | Forecast                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Estimated authored change | Approximately 250–400 lines across the V2 adapter/tool seam, focused tests, and capability evidence                    |
| Review-budget status      | Advisory threshold; count authored additions and deletions before commit                                               |
| Delivery strategy         | `ask-on-risk`                                                                                                          |
| Expected work unit        | One cohesive read-only V2 `workflow-list` registration with cleanup and regression proof                               |
| Main risk driver          | V2 Effect/schema adaptation may expose hidden coupling in the existing V1 tool assembly                                |
| Escalation trigger        | More than 400 authored changed lines, a second independent tool/event, or broad runtime migration                      |
| Escalation action         | Stop before commit and ask whether to split at the smallest independent boundary or accept a documented size exception |
| Generated output          | Excluded from authored estimate but included in build verification and complete diff review                            |

This forecast is advisory only. Do not compress code, remove tests, or hide necessary evidence to
fit a line target.

## Ask-on-Risk Gate

Stop and ask before proceeding if the implementation requires another V2 tool/event, changes the
existing plan or trackers, needs broad V1 runtime migration, crosses the 400-authored-line review
threshold, or cannot preserve project/session isolation without an expanded contract. Do not
silently widen this work unit.

## Progress

- Status: implementation complete; host smoke remains externally blocked.
- Completed checklist items: V2L-001 through V2L-018.
- Blocked items: host-level smoke proof; the smoke harness references missing `~/.secrets/crpt-ai`.
- Current implementation boundary: V2 read-only `workflow-list` only.

## Evidence

- Contract evidence: `node_modules/@opencode/plugin/dist/promise/tool.d.ts` and
  `node_modules/@opencode/schema/dist/tool.d.ts` confirm transform/add, JSON-schema input,
  Tool.Result, Tool.Error, and Promise-based V2 ToolContext execution.
- Application extraction evidence: `formatWorkflowList` is shared by V1 and V2; V2 uses
  `listProfiles` directly and performs no session load, save, queue, or mutation.
- Focused tests: `bun test test/app/v2-plugin-adapter.test.ts test/app/plugin-v2-contract.test.ts`
  passed: 18 tests, 46 expectations.
- Regression evidence: the same focused command covers existing V2 before/after/parent behavior;
  `mise run check` passed: 1820 tests, 3935 expectations, 0 failures.
- Typecheck: `mise run typecheck` passed. The full-suite environment issue was fixed by making V2
  path resolution ignore process-wide profile/harness overrides and using an isolated project-local
  fixture; the production V2 path is now independent of concurrent V1 environment mutation.
- Build/generated-output inspection: `mise run build` passed; `git diff -- dist` and
  `git status --short -- dist` were empty.
- Host smoke: `mise run smoke` was attempted and blocked before plugin execution because the
  temporary configuration references missing `~/.secrets/crpt-ai` (`bad file reference`).
- Final diff verification: `git diff --check` passed; no generated output was edited manually.
- Rollback boundary: remove only the V2 `workflow-list` registration/extraction, its focused tests,
  capability evidence, tracker changes, and generated output produced by this slice.
- Work-unit commit: pending.

## Next Step

Create the conventional work-unit commit for this completed `workflow-list` slice. Do not begin
another custom tool or event slice until host smoke is available.
