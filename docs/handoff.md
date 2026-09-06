# Handoff — session-guard

Single continuation document. **Supersedes `handoff-2026-09-06.md` and
`handoff-2026-09-06-task-scope.md`**, which had drifted apart: the second
summarised the first's open list as "items 3, 6, 20-24" and silently dropped
14-19 and the dead e2e test. Every item below was re-checked against the code
on 2026-09-06, not carried over on trust.

Last updated 2026-09-06.

## Where things stand

| | |
| --- | --- |
| Branch | `main` |
| Last commits | `f05fb1f` gates from the profile, `fa78850` task scope and per-move invariants |
| `bun test` | 1579 pass / 0 fail |
| `tsc --noEmit`, `mise run build` | clean |
| `mise run lint` | 47 errors, all pre-existing formatting; no overlap with recently touched lines |
| `openspec validate` | valid |
| `bun run smoke` | 8/11 — see below; `cicd-full-cycle` not run, that profile is still being written |

### Host smoke, 2026-09-06

Every scenario except `cicd-full-cycle`, which the operator asked to skip while
its profile is in progress. Report at `docs/host-smoke.md`.

| Scenario | |
| --- | --- |
| plugin-loads, no-session, create, git-block, commit-gate, plan-consent | PASS, 1 attempt |
| task-control | PASS, 2 attempts |
| verify-loop | PASS, 6 attempts — a prompt problem, not a finding, but six is worth looking at |
| commit-mismatch | was ERROR `spawnSync is not defined` — **fixed** (`scripts/host-smoke/run.ts` used it at line 908 and never imported it); PASSes on re-run, 6 attempts |
| comprehensive-full-cycle | FAIL — a real defect, item 0 below |
| commit-receipt | FAIL, reproduced twice, cause not established — see below |

**`commit-receipt` — what is known.** It fails with `commit-task: nothing
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

## Open — verified, in the order I would take them

### Correctness

0. **A mutation before any dispatch parks the task in a stage no profile has.**
   `resolveMutationRun` (`src/domain/operation-lifecycle.ts:37`) synthesises a
   `LoopRun` with `stage: 'mutation'` when a `bash` or `write` arrives with no
   open run. `'mutation'` is not a stage: it is a literal, of the same family
   as `'PLANNING'` below. Every later `task` dispatch for that task then hits
   `nestedStages(loopStage).find(c => c.id === stageId)` at
   `src/app/runtime.ts:823`, misses, and is refused — permanently.
   **Caught by the host smoke run**, which is the whole point of having one:
   `comprehensive-full-cycle` failed with *"Stage mutation is not declared by
   stage execution"*, and the model correctly reported it could not proceed.
   The right value is the loop's first nested stage (`firstNestedStageId`), but
   `resolveMutationRun` holds only the session, not the profile — which is why
   the literal is there. Plumbing the engine in is the fix; it is not a rename.

1. **`checkTransition` is fail-open without a session**
   (`src/domain/engine.ts:188`). In `evaluateTransition` the guard runs only
   `if (guard && … && session)`, consent only `if (transition.consent &&
   session && …)`, and `requiredGates` degrades to `[]` so the `kind: 'pass'`
   branch passes. With no session every edge is allowed.

2. **Parent/child session linkage does not exist.** `parentID` is read at
   `src/session/session-store.ts:65` out of `session.testStatus['parentID']`
   and written **nowhere in `src`** — only in a test. So `parentCache` is
   always identity and `SessionQueue.resolveRoot` is a no-op in production.
   Consequence, reproduced end to end by the host smoke run: a dispatched
   subagent edits in its own session, so `writeScope` / `readScope` never reach
   its writes and the parent's `invariants` gate never turns green from
   delegated work — which is all the work this workflow does. Both scope
   requirements carry a "Stated limitation — session locality" paragraph
   saying so.
   Use `client.session.get({ sessionID }).parentID` with a cache
   (`src/tui/index.tsx:152-171` already does), **not** the host's SQLite:
   there are two session tables, so that schema has migrated once already.

3. **No optimistic concurrency in `WorkflowStore.save`.** `revision` is
   incremented but never compared against what is on disk. In `SessionQueue`
   the `queues` map is only ever cleared wholesale (`clear()`), never per key.

### Schema machinery — status corrected

The morning handoff listed 14-19 as open. Re-checked:

| | Claim | Now |
| --- | --- | --- |
| 14 | `compileWorkflow` never called from `src` | **closed** — `src/app/mutation-orchestrator.ts:263` |
| 15 | `exitGuards` unread, `stageLevelGuards` unpopulated | **half** — the array form is read (`src/domain/task-movement.ts:76`); `stageLevelGuards` is still never populated, `mergeSchemasToEngineConfig` does not return it |
| 16 | `onFailure` has no consumer | **open** — compiled into `CompiledTransition`, read by nobody |
| 17 | no profile uses `kind: pass\|fail` | **open** — it appears only in `profiles/android/task-cycles.yaml`, which declares itself unregistered |
| 18 | `deriveStageFn` falls back to `'PLANNING'` | **open** — see the stage-name audit below |
| 19 | `editingAgents` / `verifiers` are declarative only | **half** — `task.editingAgents` is enforced at `src/app/runtime.ts:843`; the schema-level `editingAgents` and `verifiers` are carried through resolution and read by nobody |

### Testing

4. **`test/e2e/live-workflow-create.test.ts` runs zero tests.** Verified by
   running it: `0 pass, 0 fail, Ran 0 tests`. It is a script with `main()` and
   no `describe`/`it`, named `.test.ts`. It looks like coverage and is not.
   Delete it or give it a body — either is fine, leaving it is not.

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
7. `src/app/runtime.ts:2520,2526` dumps raw tool arguments (2000 chars) at
   `info` on every call — file contents and secrets reach the logs.
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
  lifecycle — `canCommit`, `deliveryPermit` / `deliveryReceipt` — stays. Do not
  implement it.
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

**Pre-stage-model chains left behind by the migration.** Same family as the
`phases:` block that was still in `android.yaml`:

- `src/tui/tui.ts:5` — `STAGES` is
  `planning, tasks_ready, code, review, qa, commit, done, failed`. `code`,
  `review` and `qa` stopped being top-level stages when `base.yaml` was rebuilt
  around the `execution` loop. It is used at `tui.ts:189-191` to show the
  previous and next stage, and `indexOf` returns `-1` for `execution` or
  `validation` — so `prevStage` is `null` and `nextStage` is `STAGES[0]`. The
  TUI tells the user that the next stage is `planning`, from anywhere real.
- `src/tui/tui.ts:118-124` — `deriveStage` guesses a stage from approvals and
  gates and can return `'code'`, `'qa'` or `'verify'`. Same vintage.

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

**Two different merge paths.** The four schemas resolve through
`mergeSchemasToEngineConfig` (per-key, last-wins) and
`SchemaLoader.mergeSchemas` (whole-field override, for schema-level
`extends:`). Do not confuse them. A third projection sits in
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
