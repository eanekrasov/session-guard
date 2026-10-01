# Give the host smoke suite its own root

## Objective

Stop the host smoke suite from living half in `scripts/` and half in the plugin's
`test/` tree. `smoke/` becomes a small project with its own runner, fixtures,
README/AGENTS, sources (`smoke/src/`) and tests (`smoke/test/`), so `scripts/` is build
tooling again and `test/` holds only the plugin's tests.

## Problem

- The suite's code sat in `scripts/host-smoke/` while its five tests sat in
  `test/app/` under a `host-smoke-` prefix — the prefix stood in for the missing
  root. `test/` is the plugin's tree; the suite is a different context with its own
  AGENTS.md and its own contract.
- `scripts/` mixed the plugin's build tooling (`build-schema.ts`, `build-tui.ts`,
  `verify-build.ts`, `check-spec-consistency.ts`, `commit-task.ts`) with a separate
  project that is never built and never published.
- The boundary was real in code but invisible in the layout: no file under the
  suite imports the plugin's `src/` (imports are `node:*`, `jsmin`,
  `@opencode/client` and its own files), yet nothing but prose said so.

## Scope

- `git mv scripts/host-smoke/ smoke/`, then the sources into `smoke/src/` — runner, harness,
  operator, report, V2 client/scenarios, `jsmin.d.ts` — with fixture profiles, README and
  AGENTS at the suite root.
- `git mv test/app/host-smoke-<name>.test.ts smoke/test/<name>.test.ts` — the
  `host-smoke-` prefix is dropped; the root carries the context now.
- Path fixes: `REPO_ROOT`, `SESSION_LOG`, the `commit-task.ts` fixture copy, the
  report path, the suite's own test imports, and the fixture path in the plugin's
  `test/schema/guard-facts-exist.test.ts`.
- Tooling: `.mise/tasks/smoke`, `.mise/tasks/typecheck` sources, `tsconfig.json`
  include, the `no-console` override in `eslint.config.js`.
- Docs: the context map in the root `AGENTS.md`, plus `smoke/README.md` and
  `smoke/AGENTS.md`.

## Out of Scope

- A separate npm package for the suite. It is the architecturally cleanest
  boundary, but nothing needs it yet: no workspaces, no lockfile entry, no CI job
  that runs against a packed tarball, and the repo maps the package name to source
  via `tsconfig.paths`. The move keeps that step cheap later.
- Renaming or merging anything in `scripts/commit-task.ts` and `profiles/base`:
  both stay where they are, read by the suite as fixtures and by the plugin's own
  tests as their own subject.
- Rewriting the historical `odd/tasks/*.md` references to the old path: those are
  records of past states, not live instructions.

## Constraints

- No behaviour change: the suite runs the same scenarios with the same assertions;
  only locations, paths and entry points move.
- The move is one atomic commit: after moving code alone, the tests in `test/app/`
  would import a directory that no longer exists.
- Nothing may silently leave type checking. Moving files out of `test/**` and
  `scripts/**` and forgetting `smoke/**/*.ts` in `tsconfig.include` would keep the
  tests running (bun discovers `*.test.ts` anywhere) while `tsc` stopped seeing
  them — coverage lost without a failure.

## Stable Task IDs

- `SR-001`: Move the suite to `smoke/` and its tests to `smoke/test/` (atomic).
- `SR-002`: Fix every path the move invalidates, including the one inbound edge.
- `SR-003`: Teach the tooling the new root (mise, tsconfig, eslint).
- `SR-004`: Update the docs that name the old location.
- `SR-005`: Freeze the boundary with an eslint rule against importing `src/**`.
- `SR-006`: Prove the move: type coverage, tests, lint, one live scenario.
- `SR-007`: Put the suite's sources in `smoke/src/` once the root `src` invariant is stated.

## Acceptance Criteria

1. `scripts/` contains only build tooling and `commit-task.ts`.
2. `test/` contains no suite tests; `smoke/test/` contains the five.
3. `bunx tsc --noEmit --listFiles` lists every file under `smoke/src/` and `smoke/test/`.
4. `bun test smoke/` runs the suite's tests alone.
5. `mise run smoke <id>` still drives a live host, including the `commit-task.ts`
   fixture copy and the report write.
6. `mise run check` passes with the same total test count as before the move.

## Checks

- `bunx tsc --noEmit --listFiles | grep /smoke/`
- `bun test smoke/`
- `mise run check`
- `mise run smoke plugin-loads commit-gate` (live)
- `git diff --check`

## Progress

- [x] `SR-001` `git mv` of the suite and its five tests; renames tracked as renames.
- [x] `SR-002` `REPO_ROOT` -> `..`, `SESSION_LOG`/report/`commit-task.ts` via
      `REPO_ROOT`, suite test imports -> `../`, fixture path in
      `guard-facts-exist.test.ts` -> `smoke/profile`.
- [x] `SR-003` `.mise/tasks/smoke` -> `bun run smoke/run.ts`; `smoke/**/*.ts` added
      to `tsconfig.include`, `.mise/tasks/typecheck` sources and the eslint
      `no-console` override.
- [x] `SR-004` root `AGENTS.md` context map, `smoke/README.md` layout and the two
      root fixtures, `smoke/AGENTS.md`.
- [x] `SR-005` `no-restricted-imports` forbids leaving the suite — any import that
      climbs above `smoke/`, and the package by name — with one block per depth
      (`smoke/src/**`, `smoke/test/**`); proven both ways with a probe in each.
- [x] `SR-007` sources moved to `smoke/src/`; `import.meta.dir` depths fixed in
      `harness.ts` (`REPO_ROOT`, profile fallback) and test imports read `../src/`.
- [x] `SR-006` type coverage verified with `--listFiles` (12 files), `bun test smoke/`
      (44 pass), `mise run check` (1902 tests, 0 fail).

## Evidence and Decisions

- The suite was already a black box in code: `grep -rn '../../src|@eanekrasov/session-guard'
scripts/host-smoke/*.ts` returned nothing, so the refactor declares a boundary
  that exists rather than creating one.
- The single inbound edge is the plugin's own schema test:
  `test/schema/guard-facts-exist.test.ts` validates the fixture profiles of
  `smoke/profile` (they are real schemas with guards). It keeps reaching in, with
  the path updated and the reason written where the path is.
- `src/` inside the suite: first rejected, then accepted once the invariant was
  stated properly — only the **root** `src/` means "compiled into `dist/`", and that
  meaning is anchored at the root (build globs `src/**/*`, `tsconfig.paths` ->
  `./src/index.ts`, published declarations). A nested `smoke/src/` cannot collide with
  those, so it costs nothing and reads as a normal project. Verified before moving:
  no glob outside `smoke/**` matches a nested `src/`.
- The boundary rule was rewritten after it caught itself: a literal `../src/*` bans
  the suite's _own_ sources from its tests once they live in `smoke/src/`. It now bans
  leaving `smoke/` (one block per depth) plus the package name, which is what the
  boundary actually means.
- Commit split: the move is one atomic commit (code alone would leave the tests
  importing a directory that no longer exists); the eslint boundary rule is a
  second, so it can be dropped independently; this record is the third.
- Landed as `3a1b38d` (move), `9f7f06c` (boundary rule), and this record.

## Mirror State

Mirrored to Engram topic `odd/smoke-suite-root/tasks` (record `#1645`, project
`session-guard`, 2026-09-27) and read back with `mem_search`. `mem_save` returned `null`
while Engram stored the record anyway, so the read-back is what proves the mirror. This
file stays the exact state.
