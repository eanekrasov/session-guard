# One file per host smoke scenario

## Objective

Stop `smoke/src/run.ts` from being three things at once. The runner keeps the CLI, the host
lifecycle, the report and the V2 dispatch; the steps a scenario is built from move to a kit; every
scenario — V1 and V2 alike — gets its own file, and the registries list them in the order each run
reports them.

## Problem

`smoke/src/run.ts` was 1389 lines holding four unrelated things: the output layer (colours, JSONL
events), the session shapes and steps (`say`, `step`, `prepareCommittableSession`, `headOf`), all
eleven V1 scenarios inline in one array, and the runner itself. A change to any one of them meant
reading past the other three, and a scenario could not be reviewed on its own — the file that
proved `commit-mismatch` also carried `cicd-full-cycle` and the V2 dispatcher.

## Scope

- `smoke/src/log.ts` — the output layer: `OUTPUT_FORMAT`, colours, `logEvent`, `logBlock`.
- `smoke/src/scenario-kit.ts` — `ATTEMPTS`, the session shapes (`Part`, `Message`, `Session`,
  `RunView`), the `Scenario`/`ScenarioResult` contracts, the operator answerer, and the steps:
  `say`, `step`, `newSession`, `prepareCommittableSession`, `headOf`, `firstRun`, `stage`,
  `debugSessionState`, plus `lastStepState()` for the runner's failure dump.
- `smoke/src/scenarios/<id>.ts` — one file per V1 scenario, named after its id:
  `plugin-loads`, `no-session`, `create`, `git-block`, `task-control`, `commit-gate`,
  `plan-consent`, `commit-cwd`, `commit-mismatch`, `cicd-full-cycle`, `verify-loop`.
- `smoke/src/scenarios/index.ts` — the ordered registry.
- `smoke/src/run.ts` — the runner only.
- `smoke/src/v2-scenario-kit.ts` — the V2 side of the same idea: `V2State`/`V2Step`/`V2Scenario`,
  `ORCHESTRATOR`, `stage`, `CONSENT_INSTRUCTION` and `runV2Scenario` (replacing
  `v2-scenarios.ts`, which held kit and scenarios together).
- `smoke/src/scenarios/v2-*.ts` — one file per V2 scenario, and `v2Scenarios` in the same
  `scenarios/index.ts`.
- `smoke/test/scenarios.test.ts` — both registries' shape, order and auto-approve set.

## Out of Scope

- No behaviour change: same scenarios, same assertions, same order, same report.
- `smoke/src/v2-client.ts` stays whole: it is transport and form-answering, not scenario shape, and
  both the kit and the scenarios use it as-is.
- The V2 scenarios were first left in one module ("one shape, three entries, splitting would add a
  second kit for a fraction of the code") and then split anyway, on the operator's call, for the
  same reason the V1 ones were: a scenario is reviewed on its own.

## Constraints

- The split is mechanical; typecheck, the suite's tests and a live run are the arbiters.
- The registry order is the report's numbering, so it is pinned by a test — a scenario that exists
  as a file but is missing from the registry would silently stop running.
- `smoke/**` still imports nothing outside the suite (eslint boundary rule).

## Stable Task IDs

- `SF-001`: Extract the output layer into `log.ts`.
- `SF-002`: Extract the shared steps and shapes into `scenario-kit.ts`.
- `SF-003`: Give every V1 scenario its own file and add the ordered registry.
- `SF-004`: Keep the runner: CLI, host lifecycle, report, V2 dispatch.
- `SF-005`: Pin the registry with a test.
- `SF-006`: Prove it: type coverage, suite tests, `mise run check`, live runs.
- `SF-007`: Give the V2 scenarios their own files and the same kit/registry shape.

## Acceptance Criteria

1. `smoke/src/run.ts` contains no scenario and no step definition.
2. Each V1 scenario is one file named after its id, exporting one `Scenario`.
3. The registry lists all eleven in the report's order, pinned by a test.
4. `bunx tsc --noEmit --listFiles` covers the new files.
5. `bun test smoke/` passes; `mise run check` passes.
6. A live V1 run and a live V2 run pass unchanged.
7. The V2 scenarios are one file each, their kit holds no scenario, and the registry lists them.

## Checks

- `bunx tsc --noEmit`
- `bunx prettier --list-different smoke/`
- `bun test smoke/`
- `mise run check`
- `HOST_SMOKE_ATTEMPTS=2 mise run smoke plugin-loads create commit-mismatch`
- `HOST_SMOKE_OPENCODE_VERSION=v2 HOST_SMOKE_ATTEMPTS=1 mise run smoke v2-workflow-create`

## Progress

- [x] `SF-001` `log.ts` (48 lines) — `OUTPUT_FORMAT` exported for the runner's human/JSONL branch.
- [x] `SF-002` `scenario-kit.ts` (524 lines) — shapes, constants, steps; `lastState` stays private
      behind `lastStepState()` so the runner's failure dump keeps working without reaching in.
- [x] `SF-003` eleven scenario files + `index.ts`; the comment about the removed
      `comprehensive-full-cycle` moved with the list it explains.
- [x] `SF-004` `run.ts` down to 273 lines: docblock, imports, signal handlers, `formatDuration`,
      `main`, `runV2Smoke`.
- [x] `SF-005` `smoke/test/scenarios.test.ts`: order, uniqueness, per-scenario shape, and the set
      of scenarios that bypass the operator answer.
- [x] `SF-007` `v2-scenario-kit.ts` + `scenarios/v2-workflow-{create,consent,tasks}.ts`, `v2Scenarios`
      registered beside the V1 list, `v2-scenarios.ts` deleted, its test renamed to
      `v2-scenario-kit.test.ts`; the registry test covers both lists.
- [x] `SF-006` typecheck 0 errors; prettier clean; `bun test smoke/` 47 pass; `mise run check` 1905
      tests 0 fail; the moved scenario bodies compared byte-for-byte (whitespace-insensitive) against
      the originals — all eleven identical; live runs below.

## Evidence and Decisions

- The split was produced by a line-range slicer (`.memory/split-scenarios.py`, scratch) that reads
  the pre-split file from a backup and writes each piece with the imports it actually mentions;
  `tsc` found the missing pieces (`REPO_ROOT` in the kit, `Scenario` in every scenario file, since
  the type appears in the declaration the slicer writes, not in the sliced block).
- Two first-attempt mistakes worth recording: the docblock slice started one line late and left an
  unterminated comment (114 parse errors — caught immediately), and the slicer's own repair patch
  broke its own syntax (filenames in a python string). Both were fixed before anything was
  committed; the pre-split file was kept in `.memory/run.ts.before-split` and verified identical to
  `HEAD`.
- Cosmetic pass after the mechanical one: blank lines between kit declarations, no shebang in
  `log.ts` (it is a module, not an entry point).
- The V1 scenarios share `prepareCommittableSession`, `headOf`, `step` and `CONSENT_INSTRUCTION`
  through the kit rather than importing each other; no scenario imports another. The V2 scenarios do
  the same through `v2-scenario-kit.ts` (their `CONSENT_INSTRUCTION` is shared by two of the three).
- Both moves are byte-for-byte: the eleven V1 bodies and, separately, the three V2 bodies plus
  `runV2Scenario`, `CONSENT_INSTRUCTION` and the three type shapes compare equal
  (whitespace-insensitive) against the pre-split versions.
- The V2 registry lives in the same `scenarios/index.ts` as the V1 one rather than under its own
  subdirectory: the `v2-` filename prefix already separates the contracts, and moving the eleven V1
  files a second time would buy structure at the cost of a rename-only diff.

## Live Receipt

2026-09-27, against the split tree:

| Command                                                                                  | Result                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `HOST_SMOKE_ATTEMPTS=2 mise run smoke plugin-loads create commit-mismatch`               | **3/3 passed**, exit 0 — `plugin-loads` 1 attempt/40.0s, `create` 1/33.0s, `commit-mismatch` 9/3.0m, report written |
| `HOST_SMOKE_OPENCODE_VERSION=v2 HOST_SMOKE_ATTEMPTS=1 mise run smoke v2-workflow-create` | failed in 3.1s with no workflow session — the model answered without calling the tool                               |
| same V2 command, `HOST_SMOKE_ATTEMPTS=2`                                                 | **1/1 passed**, 1 attempt/5.9s                                                                                      |

The V2 first attempt is not a regression from this split, and two independent checks say so:
`runV2Smoke` is byte-identical to the pre-split version (only the file-end `await main();` and one
prettier reflow differ), and the same signature — `workflow state was (none)` after a couple of
seconds — appeared once before the split, when the V2 client still sent no agent. Retries cover it,
which is what `HOST_SMOKE_ATTEMPTS` is for.

Which scenarios were run live: three V1 (`plugin-loads`, `create`, `commit-mismatch`) chosen to
cover the runner, `step`/`say`, and the kit tail (`prepareCommittableSession`, `headOf`); the other
eight are verbatim moves pinned by the byte-comparison above and the registry test. A full V1 sweep
was not run in this task.

After the V2 split, the whole V2 set and one V1 sanity check:

| Command                                                               | Result                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `HOST_SMOKE_OPENCODE_VERSION=v2 HOST_SMOKE_ATTEMPTS=2 mise run smoke` | **3/3 passed**, exit 0 — `create` 1 attempt/3.6s, `consent` 2/9.2s, `tasks` 3/10.5s |
| `HOST_SMOKE_ATTEMPTS=2 mise run smoke plugin-loads`                   | **1/1 passed**, 35.9s, report written                                               |

## Mirror State

Mirrored to Engram topic `odd/smoke-scenario-files/tasks` (record `#1646`, project `session-guard`,
2026-09-27) and read back with `mem_search`. As before, `mem_save` returned `null` while Engram
stored the record, so the read-back is the proof. This file stays the exact state.
