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
| commit-cwd | FAIL, reproduced twice, cause not established — see below |

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

## The TUI read a session shape that no longer exists

Fixed 2026-09-06. It was not one stale constant but three independent reads of
a schema that had moved on, and the tests fed every one of them the old shape,
so all of it was green while none of it worked. Proven before and after on a
real `createSession` session with one running operation:

| | Was | Now |
| --- | --- | --- |
| `stage` | `execution` | `execution` — always correct, it reads `currentStage` |
| `prevStage` / `nextStage` | `null` / `planning` | `tasks_ready` / `validation` |
| open calls | none shown | the operation, its task and its agent |

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

| Breakage | What happens |
| --- | --- |
| Broken YAML syntax | **throws** `YAMLParseError` |
| Wrong type for a field (`loop: 42`) | **throws** `ZodError` at `ProfileSchemaSchema.parse` |
| An unknown key (`phases:`) | loads, no errors, silently ignored |
| A gate the profile does not declare, a transition to a stage that does not exist | loads, reported as compile errors |
| A guard expression that cannot parse | loads, **no compile error**, evaluates to `false` for ever |
| No such file | `loadSchemaFromPath` returns `null` |

Only the first two throw, so invalid fixtures must be broken *semantically* —
`compileWorkflow`'s own errors — and not by shape.

**The table is about loading a file. In production the semantic row is fatal
too:** `resolveEngine` (`src/app/mutation-orchestrator.ts:263`) compiles the
merged workflow and throws `ProfileConfigurationError` when there is any error,
so a gate nobody declares freezes the session with a readable reason, exactly
like a bad type does. Nothing crashes in any of the six rows — measured by
driving the real hooks against a profile with `loop: 42`:

| Entry point | What the caller sees |
| --- | --- |
| `tool.execute.before` (`bash`, `task`) | caught, converted to `WorkflowBlockedError` with the reason |
| `tool.execute.after` (`task`) | returns cleanly; its own catch at `runtime.ts:1794` logs a warning |
| `workflow.tasks-get` | catches, returns the message as tool output |
| `workflow.tasks-set`, `tasks-set-status` | **throw a raw `ProfileConfigurationError`** |

The last row is the odd one and the cause is exact: `tasks-get` is open to any
caller, while the others go through the task-control authority check, which
resolves the engine at `runtime.ts:221` — before the handler's own `try`. Two
neighbouring tools, one broken profile, two shapes of failure, and the agent
sees a raw error instead of the plugin's structured refusal.

The two middle rows are worse than a throw. The unknown-key row is exactly how
`android.yaml` carried a dead `phases:` block for months. And **the compiler
does not check guard syntax at all**: `"session.gates.((("` compiles clean and
then reads `false` for ever, so the transition simply never fires. The
evaluator reports the parse failure through `onError` at runtime, but nothing
refuses the profile at load. The compiler's own comment says it exists to turn
silence into an error; guard syntax is a hole in that, of the same kind the
gate declaration just closed.

**Fixed while measuring:** `validateNestedStages` reported every nested stage's
bad gate twice — the parent's walk checked `entry.gates` and then recursed into
that stage, whose own call checked the same gates under the same path. The
tests used `toContain`, which cannot see a duplicate; the new test counts.

## Next: one funnel for every error the plugin reports

Agreed 2026-09-06, not started. Every error should reach the operator as
readable text, go to the log, and — with debug on — show as a toast.

The pieces already exist and are used once each:

- **Toast**: `client.post('/tui/show-toast', { body: { message, variant } })`,
  at `src/app/runtime.ts:457`. One call site, for "no profiles found".
- **Log**: `createLogFn` (`src/app/logger.ts`), thresholded by
  `STATE_MACHINE_LOG_LEVEL`.
- **Refusal**: `WorkflowBlockedError`, which the host renders as a failed tool
  call carrying the message.

What is missing is that they are not one path. The toast is gated on
`DEBUG_TUI !== '0'` while the log is gated on `STATE_MACHINE_LOG_LEVEL` — two
switches for one idea of "debug". And a `ProfileConfigurationError` escapes
`workflow.tasks-set` unwrapped while the same error becomes tool output in
`workflow.tasks-get`, so what the operator sees depends on which tool they
happened to call.

Two related gaps in what the compiler catches at all:

1. **Unknown keys pass in silence.** `ProfileSchemaSchema` is `.passthrough()`
   (`src/schema/profile-schema.ts:155`), which is why `android.yaml` carried a
   dead `phases:` block for months. `.strict()` would throw at parse, but
   `ResolvedSchema` carries an index signature and something may rely on the
   extra keys — so report them as compile errors instead, where they join the
   same funnel as an undeclared gate and can carry a path and a whitelist.
2. **Guard syntax is never checked.** The compiler walks every transition and
   every stage already; it does not parse the expressions. `guard-ast.ts` is
   the parser, and the evaluator already reports failures through `onError` at
   runtime — so this is collecting the expressions (transition guards, entry
   and exit guards, `actionGuards`, stage-assignment conditions) and parsing
   them at compile time. Bounded work, not hard.

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

**Constraints that still hold.** A deliberately-invalid fixture must be broken
*semantically* — an undeclared gate, a transition to a stage that does not
exist — never by shape: a wrong type throws at `ProfileSchemaSchema.parse`
before the compiler sees it, so the refusal under test never happens.
`missing-extends/` is the precedent for keeping one beside the good profiles.

**Precondition, already fixed.** The engine cache was keyed on `profileId`
alone while `profilesDir` is read from the environment on every call, so a
helper pointing one id at two fixture directories would have been served the
first in silence (`9ba3d32`). `test/fixtures/profiles/cache/{good,bad}` is what
covers it.

Left as it was: `test/fixtures/profiles/base` still carries
`beginMutation: "session.approved('plan') || session.revision == 0"`. The
`revision == 0` escape hatch is the one called wrong when it was found in the
android profile, and a fixture should not teach it.

## How a broken profile actually behaves

Measured 2026-09-06, by loading one file per kind of breakage. This matters
because a fixture corpus of deliberately-invalid profiles is only possible for
the kinds that fail as data.

| Breakage | What happens |
| --- | --- |
| Broken YAML syntax | **throws** `YAMLParseError` |
| Wrong type for a field (`loop: 42`) | **throws** `ZodError` at `ProfileSchemaSchema.parse` |
| An unknown key (`phases:`) | loads, no errors, silently ignored |
| A gate the profile does not declare, a transition to a stage that does not exist | loads, reported as compile errors |
| A guard expression that cannot parse | loads, **no compile error**, evaluates to `false` for ever |
| No such file | `loadSchemaFromPath` returns `null` |

Only the first two throw, so invalid fixtures must be broken *semantically* —
`compileWorkflow`'s own errors — and not by shape.

**The table is about loading a file. In production the semantic row is fatal
too:** `resolveEngine` (`src/app/mutation-orchestrator.ts:263`) compiles the
merged workflow and throws `ProfileConfigurationError` when there is any error,
so a gate nobody declares freezes the session with a readable reason, exactly
like a bad type does. Nothing crashes in any of the six rows — measured by
driving the real hooks against a profile with `loop: 42`:

| Entry point | What the caller sees |
| --- | --- |
| `tool.execute.before` (`bash`, `task`) | caught, converted to `WorkflowBlockedError` with the reason |
| `tool.execute.after` (`task`) | returns cleanly; its own catch at `runtime.ts:1794` logs a warning |
| `workflow.tasks-get` | catches, returns the message as tool output |
| `workflow.tasks-set`, `tasks-set-status` | **throw a raw `ProfileConfigurationError`** |

The last row is the odd one and the cause is exact: `tasks-get` is open to any
caller, while the others go through the task-control authority check, which
resolves the engine at `runtime.ts:221` — before the handler's own `try`. Two
neighbouring tools, one broken profile, two shapes of failure, and the agent
sees a raw error instead of the plugin's structured refusal.

The two middle rows are worse than a throw. The unknown-key row is exactly how
`android.yaml` carried a dead `phases:` block for months. And **the compiler
does not check guard syntax at all**: `"session.gates.((("` compiles clean and
then reads `false` for ever, so the transition simply never fires. The
evaluator reports the parse failure through `onError` at runtime, but nothing
refuses the profile at load. The compiler's own comment says it exists to turn
silence into an error; guard syntax is a hole in that, of the same kind the
gate declaration just closed.

**Fixed while measuring:** `validateNestedStages` reported every nested stage's
bad gate twice — the parent's walk checked `entry.gates` and then recursed into
that stage, whose own call checked the same gates under the same path. The
tests used `toContain`, which cannot see a duplicate; the new test counts.

## Next: one funnel for every error the plugin reports

Agreed 2026-09-06, not started. Every error should reach the operator as
readable text, go to the log, and — with debug on — show as a toast.

The pieces already exist and are used once each:

- **Toast**: `client.post('/tui/show-toast', { body: { message, variant } })`,
  at `src/app/runtime.ts:457`. One call site, for "no profiles found".
- **Log**: `createLogFn` (`src/app/logger.ts`), thresholded by
  `STATE_MACHINE_LOG_LEVEL`.
- **Refusal**: `WorkflowBlockedError`, which the host renders as a failed tool
  call carrying the message.

What is missing is that they are not one path. The toast is gated on
`DEBUG_TUI !== '0'` while the log is gated on `STATE_MACHINE_LOG_LEVEL` — two
switches for one idea of "debug". And a `ProfileConfigurationError` escapes
`workflow.tasks-set` unwrapped while the same error becomes tool output in
`workflow.tasks-get`, so what the operator sees depends on which tool they
happened to call.

Two related gaps in what the compiler catches at all:

1. **Unknown keys pass in silence.** `ProfileSchemaSchema` is `.passthrough()`
   (`src/schema/profile-schema.ts:155`), which is why `android.yaml` carried a
   dead `phases:` block for months. `.strict()` would throw at parse, but
   `ResolvedSchema` carries an index signature and something may rely on the
   extra keys — so report them as compile errors instead, where they join the
   same funnel as an undeclared gate and can carry a path and a whitelist.
2. **Guard syntax is never checked.** The compiler walks every transition and
   every stage already; it does not parse the expressions. `guard-ast.ts` is
   the parser, and the evaluator already reports failures through `onError` at
   runtime — so this is collecting the expressions (transition guards, entry
   and exit guards, `actionGuards`, stage-assignment conditions) and parsing
   them at compile time. Bounded work, not hard.

## A fixture corpus, and the pattern that earns it

Agreed 2026-09-06, not started. **Tests come first** — the fixtures cannot move
until the assertions over them do.

`docs/plans/` is in `.gitignore`, so a plan file there is a local note and
nothing a later session is guaranteed to find. The survey that cost the effort
therefore lives here.

**What the vocabulary change actually costs: one assertion.**

| Consumer | What it asserts about the fixtures |
| --- | --- |
| `test/schema/schema-loader.test.ts` | **`stages.PLANNING` is defined** (line 31) — the only assertion naming a stage; then settings deep-merge (`mutationTtlMs` 600000 overrides, `retryMaxAttempts` 3 inherits) and that transitions are overridden |
| `test/schema/profile-loader.test.ts` | the ids listed, `base` metadata, `agentsDir` / `skillsDir` defaults, `no-id-profile` deriving its id, `missing-extends` rejecting |
| `test/public-api.test.ts` | android metadata and inherited fields, `schemas[0].source` |
| `test/e2e/integration.test.ts` | the same metadata, plus the settings deep-merge |
| `test/app/mutation-orchestrator.test.ts` | `base` only, for engine resolution |

Everything else is metadata and merge mechanics, and that is what those tests
are actually about — so it must survive the rewrite: `agents: ['code',
'architect']`, the skills and invariants, android's custom `agentsDir` /
`skillsDir`, iOS's `guardsTs`, and android's overriding `mutationTtlMs`.

**Then the profiles.** `base/state-machine.yaml` becomes the current model —
lowercase stages, the `execution` loop over `code` / `verify`, a top-level
`gates:` declaration — keeping `settings`, `stageAssignments` (the only fixture
exercising `deriveStageFn`) and `requiredGates`. Drop its
`beginMutation: "session.approved('plan') || session.revision == 0"`: the
`revision == 0` escape hatch is the one called wrong when it was found in the
android profile, and a fixture should not teach it. `android` and `ios` stay
deltas through schema-level `extends` and declare only what differs.

**Deliberately-invalid fixtures** go alongside the good ones, as
`missing-extends/` already does, and must be broken semantically — an
undeclared gate, a transition to a stage that does not exist — never by shape.

**Two tests added on 2026-09-06 write their profiles inline** into a temp
directory (`test/app/mutation-orchestrator.test.ts`), which is the fourteenth
and fifteenth instance of what this removes. They move first: one wants the
invalid fixture, the other needs one profile id under two roots. `test/fixtures/presets/` is the ancestor of
`base.yaml`: `high`/`medium`/`low.yaml` are ProfileSchema files of the same
format, from before the stage model — stages in uppercase, not a `loop:` among
them — and `default.yaml` is one generation older still, a flat `stages:` list
plus a `deriveStageRules` block in a condition language this project does not
have. The decision is to keep the fixtures but replace their content wholesale
with current profiles, schemas and agent prompts, so tests can lean on a real
configuration instead of writing one inline.

The case, measured: **17 test files** write profile YAML on the fly, **226
lines** of inline YAML across the ten that do it at length, and
`loop: implementation` is declared again in **13 different files**. The worst is
`test/app/parallel-verifiers.test.ts` — 74 lines assembled by
`writeProfile(transitions, guardInvariants, consentToFinish, selfLoop,
approveOnMove)`, five booleans concatenating YAML, where a sixth scenario means
a sixth flag.

`scripts/host-smoke/profile/` is the model: `smoke`, `comprehensive` and `cicd`
are complete current-format profiles with `profile.json`, a schema and
`agents/*.md`, and they are exercised against a live opencode, so they cannot
rot unnoticed.

**The pattern to use is `resolveEngine` against a directory**, not
`compileWorkflow` against a literal. That is the call production makes, and it
is the difference between catching a lost field and not: the gate check was
dead in production for a day precisely because both tests over it passed their
own `gates` to the pure function. A test that points
`STATE_MACHINE_PROFILES_DIR` at a fixture and resolves gets the whole chain —
resolution, the field projections, merging, compilation.

Two constraints on the corpus:

- **Deliberately-invalid fixtures must be broken semantically**, never by
  shape: a wrong type throws at `ProfileSchemaSchema.parse` before the compiler
  ever sees it (see the breakage table above). An undeclared gate or a
  transition to a stage that does not exist loads fine and is refused with a
  reason — which is what a refusal test wants.
- **The engine cache had to be keyed on the directory** before this was safe.
  It was keyed on `profileId` alone while `profilesDir` is read from the
  environment on each call, so a shared helper pointing one profile id at two
  fixture directories would have been served the first one in silence. Fixed
  and covered.

Keep the inline YAML in `test/schema/compile-validation.test.ts` where it is:
those schemas are deliberately wrong, and they are the test's input rather than
duplication.
