# Smoke Diagnostic Trace

## Objective

Make a failed `mise run smoke` step distinguish model/tool/host/persistence causes instead of
collapsing them into the same `BLOCKED` summary.

## Scope

- Add structured trace events at prompt, normalized tool-call, durable checkpoint, and step
  boundaries in `smoke/**`.
- Preserve existing scenario verdicts, timeout budgets, retry rules, and current unrelated dirty
  changes.
- Keep the trace available through the existing `HOST_SMOKE_LOG_LEVEL=debug` output path.

## Stable Task IDs

- `SDT-001`: Define the trace event contract and regression tests.
- `SDT-002`: Emit prompt and normalized tool evidence from V1/V2 transports.
- `SDT-003`: Emit runner step and durable workflow checkpoint events.
- `SDT-004`: Run focused smoke checks and record observed output.

## Acceptance Criteria

1. A failed step reports `prompt started`, `session.step.started`, tool names/statuses including
   `tools=[]`, `tools=[task]`, or `tools=[workflow-result]`, a durable `workflow checkpoint`, and
   `session.step.finished`.
2. Durable checkpoint output includes revision, stage, and gate statuses when available.
3. Trace output does not change the runner's pass/fail/blocked decisions or timeout behavior.
4. Focused tests cover the trace formatter and runner event sequence.
5. Existing unrelated working-tree changes remain untouched.

## Checks

- `bun test smoke/test/host-runner.test.ts smoke/test/host-transport.test.ts`
- `bunx tsc --noEmit`
- `bunx prettier --list-different smoke/`
- `git diff --check`

## Progress

- [x] `SDT-001` Define the trace event contract and regression tests.
- [x] `SDT-002` Emit prompt and normalized tool evidence from V1/V2 transports.
- [x] `SDT-003` Emit runner step and durable workflow checkpoint events.
- [x] `SDT-004` Run focused smoke checks and record observed output.

## Verification Receipt

- `bun test smoke/test/trace.test.ts smoke/test/host-transport.test.ts smoke/test/host-runner.test.ts`:
  105 pass, 0 fail, 335 expectations.
- `bunx tsc --noEmit` from `smoke/`: passed.
- `bunx prettier --list-different smoke/`: no output; clean.
- `git diff --check`: clean.
- `HOST_SMOKE_ATTEMPTS=1 HOST_SMOKE_LOG_LEVEL=debug mise run smoke plugin-loads`: passed, 2/2
  host-parity scenarios, exit 0. The live log showed `session.step.started`, `prompt started`,
  `tool.execute.after: tools=[workflow-list:completed]`, `workflow checkpoint`, and
  `session.step.finished`; V2 also showed a timed-out transport result whose tool evidence was
  recovered from the host messages and still passed from the durable/normalized observation.

## Plugin-side Trace Extension

- Added `src/app/trace.ts` with bounded tool summaries, sensitive-field redaction, error
  normalization, and elapsed-time helpers.
- Replaced raw hook input JSON logging in `src/app/runtime.ts` with structured
  `tool.execute.before/after` start, finish, and failure events.
- Added `test/app/trace.test.ts` for redaction, bounded nested summaries, and error diagnostics.

## Verification Receipt (Plugin Extension)

- `bun test test/app/trace.test.ts test/app/logger.test.ts`: 7 pass, 0 fail.
- `mise run check`: 2058 pass, 0 fail; lint had only the existing 8 `no-explicit-any` warnings.
- `mise run build`: passed; build verification confirmed all outputs and distinct entrypoints.
- `git diff --check`: clean.
- `HOST_SMOKE_ATTEMPTS=1 HOST_SMOKE_LOG_LEVEL=debug mise run smoke plugin-loads`: passed, 2/2,
  exit 0 on V1 and V2. The live output showed the new safe hook events and durations.
