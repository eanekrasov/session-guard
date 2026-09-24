# Plugin V2 implementation

## Objective

Implement the V2 OpenCode plugin entrypoint over the existing Session Guard runtime,
while preserving the V1 entrypoint and avoiding a second policy engine.

## Problem

`SessionGuardPluginV2` is currently a smoke-test stub, while `createRuntime` is coupled
to the V1 `PluginInput` and returns V1 hooks. The V2 host has a different event contract,
especially for `execute.after`.

## Scope

- Confirm the installed V2 host contract.
- Introduce a narrow runtime-facing adapter seam.
- Implement V2 before/after tool lifecycle progressively.
- Preserve project isolation, workflow block semantics, and cleanup behavior.
- Document and test unsupported V2 capabilities.

## Constraints

- Keep V1 and V2 as separate supported entrypoints.
- Do not cast V2 `Context` to V1 `PluginInput`.
- Reuse existing application/domain behavior.
- Do not edit generated artifacts manually.
- Technical artifacts remain in English.

## Effective checks

- TDD mode: standard; source not yet re-queried from project cache.
- Focused tests: `bun test <focused-test>`.
- Required source checks: `mise run check`, `mise run build`.
- Host integration check when V2 loading changes: `mise run smoke`.

## Tasks

- [x] V2.1 Confirm the installed V2 contract and create a capability matrix.
- [x] V2.2 Add characterization tests and a narrow runtime-facing contract.
- [ ] V2.3 Adapt V2 setup and `execute.before` without changing V1 behavior.
- [ ] V2.4 Adapt V2 `execute.after` for completed and failed calls.
- [ ] V2.5 Add supported tool/event integrations and capability tests.
- [ ] V2.6 Harden partial setup, cleanup, project isolation, and concurrency.
- [ ] V2.7 Run build and host smoke verification; update documentation.

## Progress

- Current task: V2.3.
- V2.1/V2.2 completed in `src/app/v2-plugin-contract.ts` and
  `test/app/plugin-v2-contract.test.ts`.
- Evidence: `bun test test/app/plugin-v2-contract.test.ts` (3 passed),
  `mise run typecheck` (passed), `mise run check` (1803 tests passed),
  `mise run build` (passed), and `git diff --check` (passed).
- Runtime host behavior was intentionally not changed, so `mise run smoke` was not
  applicable to this work unit.

## Acceptance criteria

- V1 behavior remains intact.
- V2 does not construct a fake V1 `PluginInput`.
- V2 before/after hooks preserve session and call identity.
- Disallowed operations are propagated as host-supported blocks.
- Every registration is disposed exactly once, including partial setup.
- Unsupported V2 capabilities are explicit in the capability matrix.
- Required checks pass, with actual results recorded here.

## Next step

Implement V2.3 as the next focused work unit: construct the V2 adapter and connect
`execute.before` without changing V1 behavior.
