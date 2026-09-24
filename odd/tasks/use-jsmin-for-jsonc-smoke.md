# Use jsmin for host-smoke JSONC configuration

## Objective

Use `jsmin` to normalize JSONC operator configuration in the host-smoke harness without
changing ordinary JSON handling.

## Problem and why

The host-smoke harness must consume an operator `opencode.jsonc` file containing comments and
trailing commas. The authorized requirement is to use `jsmin` for that JSONC normalization.

## Scope

- `scripts/host-smoke/` JSONC configuration transformation and its focused test.
- The smallest declared dependency or tool configuration necessary to make `jsmin` available.
- Host-smoke documentation only if a new prerequisite requires it.

## Constraints

- Do not change unrelated `jq` use for ordinary package JSON.
- Do not run live host smoke.
- Do not print configuration secrets.
- Do not manually edit generated `dist/` files.
- Do not use `but` or Git write commands.

## Stable tasks

- [x] JS-001 Record the work unit and inspect the existing configuration path.
- [x] JS-002 Add a focused red test through the host-smoke operator configuration path.
- [x] JS-003 Use `jsmin` only for `.jsonc` input and preserve malformed-config behavior.
- [x] JS-004 Run focused and required verification checks.
- [x] JS-005 Determine permitted commit mechanism or report the uncommitted state.

## Acceptance criteria

1. JSONC comments and trailing commas are removed before JSON parsing.
2. The requested provider and model configuration survive the host-smoke transformation.
3. Ordinary `.json` configuration is parsed without JSONC normalization.
4. Invalid configuration does not masquerade as valid configuration or expose its contents.
5. No unrelated `jq` processing changes.

## Checks

- Focused host-smoke harness test demonstrates red then green.
- `mise run check`
- `mise run build`
- `git diff --check`
- Inspect `git diff -- dist` after the build.

## Progress

Discovery found no `jq` invocation in the current host-smoke configuration path: it has a
handwritten `parseJsonc` helper used for both `opencode.json` and `opencode.jsonc`. Existing
`jq` uses are limited to `.mise/tasks/` package-version and package-script checks, so they are
outside this work unit. An ambient `jsmin` binary exists, but it is not declared in the project;
the implementation must not depend on it implicitly. The focused JSONC test was red because the
host-smoke configuration reader was not exposed to tests; it is now exported only as the tested
configuration-path seam. `jsmin@1.0.1` is declared as a development dependency. Its API removes
comments but preserves trailing commas, so the harness removes only syntactic trailing commas in
a separate string-aware scan before `JSON.parse`. A malformed JSONC fixture is ignored as before;
its contents are not logged.

Verification passed: focused `bun test test/app/host-smoke-harness.test.ts`, `mise run check`,
`mise run build`, and `git diff --check`. The build reported sources up to date and did not alter
`dist/`; `git diff -- dist` is empty. Live smoke was intentionally not run. No permitted
version-control write mechanism was identified under the constraints forbidding both `but` and raw
Git write commands, so these focused changes remain uncommitted.
