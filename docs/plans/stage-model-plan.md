# Stage model — what we are building

Working plan. Companion to `docs/plans/stage-model.md`, which states the model
itself; this file tracks the target schemas, what is done, and what is left.

Decided with the operator on 2026-09-06.

---

## The target workflow

### Variant A — validation and commit outside the loop

```yaml
stages:
  planning:                      # architect writes the plan; consent gates it
    allowedAgents: [architect]

  tasks_ready:                   # decomposition via workflow-tasks-set
    allowedAgents: [architect]

  execution:                     # the loop
    loop: implementation
    stages:
      code:
        allowedAgents: [code, debug]
      verify:                    # review and qa, in parallel, in one stage
        allowedAgents: [review, qa]
        gates: [review, qa]
    transitions:
      - { from: code,   to: verify, guard: "task.gates.invariants == 'passed'" }
      - { from: verify, to: code,
          guard: "task.gates.review == 'failed' || task.gates.qa == 'failed'",
          effects: [{ bumpRetry: task.id }] }

  validation:                    # one check over the whole body of work
    allowedAgents: [review, qa]
    gates: [review, qa]

  commit: {}
  done: {}

transitions:
  - { from: planning,   to: tasks_ready, guard: "session.refs.plan != null", consent: plan }
  - { from: tasks_ready, to: execution,  guard: "hasPendingTasks()" }
  - { from: execution,  to: validation,  guard: "allTasksCompleted()" }
  - { from: validation, to: commit,      guard: "session.gates.review == 'passed' && session.gates.qa == 'passed'" }
  - { from: commit,     to: done,        guard: "session.deliveryReceipt != null" }
```

### Variant B — commit inside the loop, no separate validation

```yaml
  execution:
    loop: implementation
    stages:
      code:
        allowedAgents: [code, debug]
      verify:
        allowedAgents: [review, qa]
        gates: [review, qa]
      commit: {}
    transitions:
      - { from: code,   to: verify, guard: "task.gates.invariants == 'passed'" }
      - { from: verify, to: commit, guard: "task.gates.review == 'passed' && task.gates.qa == 'passed'" }
      - { from: verify, to: code,
          guard: "task.gates.review == 'failed' || task.gates.qa == 'failed'",
          effects: [{ bumpRetry: task.id }] }
```

Both variants must be expressible without a code change — that is the test of
whether the model is right. Each task commits its own work in B, so the
delivery permit's `expectedFiles` is per task, which is what it already means.

---

## Two subagents in one stage — decided

`verify` runs review and qa **in parallel inside one stage**, so a tag cannot
name the stage it came from: there are two of them.

**The tag names a gate, not a stage.** A stage declares what it is waiting for:

```yaml
verify:
  allowedAgents: [review, qa]
  gates: [review, qa]
```

The review agent finishes with `stage: review`, the qa agent with `stage: qa`.
The stage's own id never appears in a tag. Rules that follow:

- a tag whose name is not among the stage's `gates:` is **refused with a
  reason** — the same check as before, against a list instead of one id;
- `pass` sets that gate to `passed`, `fail` to `failed`, on the task's own run;
- the stage is passed when every gate it declares is `passed`; it is failed as
  soon as one is `failed`;
- a stage with no `gates:` is not a verifier and needs no tag.

This keeps one nesting rule and one arrival rule, and `gates:` stays the single
field that carries the whole verifier contract.

## Where we are

| Slice | State |
|---|---|
| 0. `phase` → `stage` throughout | **done** — 649 replacements, 62 files, tests green |
| 1. Schema: recursive `StageDef`, nested `stages`, `transitions`, `gates:` | **done** — schema accepts the new shape; profiles and fixtures converted |
| 2. Engine: transitions drive movement inside a loop | **done** — `src/domain/task-movement.ts` decides; a loop with no transitions still runs its stages in declaration order. `test/domain/task-movement.test.ts`, `test/app/parallel-verifiers.test.ts` |
| 3. Gates on the task run; a tag closes a gate; parallel verifiers | **done** — `loopRuns[].gates`, a tag names a gate, an undeclared name is refused, a stage passes when all its gates pass and fails on the first failure. `test/app/parallel-verifiers.test.ts` |
| 4. `compileWorkflow` wired in and validating at load | **done** — every engine is compiled before it runs; a defect in the file stops the workflow with the defect named |
| 5. `base.yaml` rewritten in the new model | **done** — planning → tasks_ready → execution [code → verify] → validation → commit → done; the shipped workflow can reach `done` for the first time |
| 6. TUI and dashboard: per-task gates | **done** — the status line shows `task-1@verify ✓review ⏳qa`, task verdicts first |
| 7. Host smoke: a live subagent returning a tag | **done** — `verify-loop`: two live subagents each close their own gate; 10/10 scenarios pass |

### How movement is decided now

A loop that declares `transitions` is moved by them and by nothing else: the
first transition out of the current stage whose guard holds wins, guards read
`task.gates`, and `effects: [{ bumpRetry: task.id }]` spends that task's own
budget. When nothing matches, the task stays where it is — a loop never moves a
task by accident.

A loop that declares no transitions runs its stages in declaration order, and a
failure falls back to the loop's retry budget. The simple linear case stays
simple, and a profile writes transitions only when it needs a branch.

An outer stage's `gates:` are closed the same way an inner one's are: a
`<workflow-result>` from an agent that is not working a task lands on the
session's gates, which is what `validation` uses to have review and qa check
the whole body of work.

Two things the rewrite settled about `base.yaml`:

- **no `allowedAgents` anywhere in it.** A roster belongs to the profile that
  ships the agents, and every profile ships a different one — `harness` ships
  one agent, `android` ships ten. Inherited rosters would name agents the child
  does not have. Profiles declare their own; the stages are the same everywhere.
- **`allTasksCompleted('implementation')` names its list.** Without an argument
  the guard infers the list from the active operation, and a stage transition
  has none — it would silently read false forever.

`bumpRetry` inside a loop must be written as `task.id`. Any other budget key is
a load error.

### What the compiler refuses, and what it found

`compileWorkflow` runs on the **merged** workflow before any engine is built —
per file would be wrong, since a delta profile names stages its parent
declares. It refuses: a loop with no stages to run, transitions on a stage with
no loop, a transition naming a stage the loop does not have, a gate no session
carries, and a `bumpRetry` that is not the task's own budget.

Wiring it up found two defects that had been sitting in the repository:

- the `base` test fixture declared transitions into `COMMIT` and `DONE`
  **without declaring those stages**. The compiler had always known; nobody
  had ever called it.
- `SchemaLoader.mergeSchemas` replaced `stages` and `transitions` as whole
  fields, so a delta profile that touched one stage silently dropped every
  other stage its parent declared — and with them, the transitions that named
  those stages. Both now merge per entry. This is the "two different merge
  paths" trap from the handoff, with a reproduction.

Gates are cleared twice over, and both are deliberate: entering a stage clears
the run's gates, and so does starting a mutation. Editing twice inside one
stage is ordinary — an architect reworking a plan with the operator does it
every time — and a verdict is evidence about the code as it was, so an edit
must invalidate it rather than inherit it.

`phaseId`, `nextPhase`, `phaseIndex`, `phaseDef` survive in `runtime.ts`,
`engine.ts` and `compile-workflow.ts` (~250 mentions). They were left alone on
purpose: `stageId`, `nextStage` and `stageIndex` already exist beside them for
the inner stages, so these sites need the two code paths merged, not the word
replaced. The surviving `phase` marks exactly where that work remains.

---

## What the live run cost, and what it found

Getting `verify-loop` green took eight runs against a real host. Every failure
was a defect, not a flake:

| Symptom | Cause |
|---|---|
| "no subagent_type named build" | `build` is the host's own primary agent; a profile has to ship its own subagents |
| "Stage execution does not declare an executable task loop" | admission required `dispatch:`, which the shipped profile does not declare — now defaults to serial |
| transitions vanished from the merged stage | `mergeSchemasToEngineConfig` replaced stages wholesale, the second of the two merge paths |
| the task sat in `code` with a valid result | `resolveLoopStage` searched each schema file separately and returned the parent's guarded edge; both stage lookups now go through the engine's merged map |
| the task sat in `verify` having passed both gates | completion required *no* outgoing transitions; `verify` has one, for failures. A passed stage that no transition takes is now where the work ends |
| the run hung with no output | the host asked for `external_directory` permission and nobody was there to answer |

## Found by the live run, still open

**A subagent's work does not reach its parent session.** The `code → verify`
edge in `base.yaml` is guarded on `session.gates.invariants == 'passed'`, and
that gate is set by the mutation lifecycle — in whichever session the edit was
made. A dispatched subagent edits in its own session, and `store.parentCache`
is never populated in production (`session.testStatus['parentID']` is written
by no code in `src`), so the parent never sees it. The guard therefore cannot
go green for delegated work, which is all work in this workflow.

Until that is fixed, a profile whose `code` stage is worked by a subagent has
to move on the agent's own result rather than on the invariants gate. The host
smoke profile does exactly that, and says why in a comment.

> **Resolved, 2026-09-07.** The chain is read from the host, not from a session
> file: `Runtime.resolveHostParent` asks `client.session.get().parentID` and is
> wired into `SessionQueue`, which memoises every hop into `parentCache`.
> `testStatus` itself has been deleted — nothing ever wrote it, and the seed
> `save()` took from it was always `sessionId → sessionId`, an entry that
> silently declared a child its own root and stopped the host from being asked.
> `save()` no longer touches the cache at all.

This is item 2 of `docs/plans/handoff.md` — parent/child session linkage — reproduced end to end.

## Defects fixed in the loop, after the model landed

Nine, found by review and by the live run. Every one was a silence — the
workflow kept going and told nobody.

| # | Defect | Now |
|---|---|---|
| 1 | a task completed when every way out was **blocked**, skipping verify | a passed stage that no transition takes is only an ending when it has no transitions at all; a loop declares its ending with `to: done` |
| 2 | any tool's output could close a gate — reading a file that quotes the marker counted as a verdict | a verdict counts only from a `task` call, by an agent the stage's roster allows |
| 3 | `edit` and `apply_patch` bypassed the mutation lifecycle: no plan approval, no invariants | every tool that changes the repository runs under it |
| 4 | two verifiers could not work one stage: the second call was refused | a stage with gates admits one call per gate; the same agent is still refused twice |
| 5 | an errored tool left its operation running for ever — the event part was read from the wrong place | the part is read where the host puts it (`properties.part`), with the flat shape as fallback |
| 6 | a retry edge without `bumpRetry` looped for ever | a failing move always spends an attempt; the effect documents it and may set a different maximum |
| 7 | the budget path did not clear the task's gates, so a task was judged on work it had not redone | both failure paths clear them |
| 8 | guards inside a loop got the raw session, where `gates` is an array — `session.gates.invariants` read `undefined` for ever | one normalisation for every guard, at either level |
| 9 | a late verdict from a finished round spent the retry budget a second time | a run carries a round; a result stamped with an older one is refused and says so |
| 10 | a nested transition ignored `consent` | consent is required at either level, including the transition that ends a task |
| 11 | a nested stage's `exitGuards` were never evaluated | they are checked before any departure, including completion |

Each is covered by a test that fails without its fix.

## Acceptance

The model is done when:

- both variants above run end to end against a real opencode, with a live
  subagent returning a `<workflow-result>` tag — not a hand-set gate;
- a task that fails review returns to `code` on its own retry budget, while its
  siblings keep going;
- a gate named by no session, a tag naming an undeclared gate, and a transition
  to a stage that does not exist are all **load or runtime refusals with a
  reason**, never silence;
- `bun test` green and `bun run smoke` green.
| 12 | the round check ran *after* the gate was written, so a refused verdict still closed a gate of the round that replaced it | the check is the first thing that happens: a stale result writes no gate and files no verification |
| 13 | a nested transition's `approve` effect was never applied — the effect handler only ran for a failure or a `bumpRetry`, and only knew about retries | every taken edge applies what it declares; the budget stays the one effect with its own conditions, and `to: done` carries its effects like any other departure |
| 14 | `hasForbiddenGitSubcommand` matched `git` followed immediately by a subcommand, so `git -C . push`, `/usr/bin/git push` and `git -c user.name=x commit` all went through | the command is tokenised (quotes, escapes, separators, substitutions) and read structurally: wrappers, env assignments, executable path and git's own global options are skipped before the subcommand is read |
| 15 | `tryApplyTransitions` judged each candidate edge by looking it up again from its endpoints, so a schema with two `a → b` edges only ever evaluated the first — and could apply the *other* edge's effects | the candidate in hand is evaluated (`evaluateTransition`); `checkTransition` keeps the endpoint lookup for callers that only have a pair |
