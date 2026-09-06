# The stage model

Decided 2026-09-06. Replaces the split between `phases` and `stages`.

## The rule

There is one unit of workflow state: the **stage**. The word `phase` disappears
from the schema, the session, the engine and the code.

A stage that names a task list runs its own stages once per task:

```yaml
stages:
  planning: {}
  tasks_ready: {}

  execution:
    loop: implementation      # this stage cycles over that task list
    stages:                   # …running these, per task
      dev:
        allowedAgents: [code, debug]
      review:
        allowedAgents: [review]
        gates: [review]
      qa:
        allowedAgents: [qa]
        gates: [qa]
    transitions:              # …and these move one task between them
      - from: dev
        to: review
        guard: "task.gates.invariants == 'passed'"
      - from: review
        to: qa
        guard: "task.gates.review == 'passed'"
      - from: review
        to: dev
        guard: "task.gates.review == 'failed' && !isExhausted(task.id)"
        effects: [{ bumpRetry: task.id }]

  commit: {}
  done: {}
```

Nesting is the only thing that distinguishes an inner stage from an outer one.
Everything else — `allowedAgents`, `gates`, `transitions`, guards, effects,
retry budgets — means the same at both levels. That is the whole point: a
reader learns one set of rules, not two.

## Why the old split had to go

`base.yaml` modelled review and qa as **phases** closed by `session.gates`.
`task-cycles.yaml` modelled them as **stages** closed by a `<workflow-result>`
tag. Subagents were written against the second, the shipped transitions against
the first, and nothing joined them: `handleWorkflowResult` wrote
`session.verifications` and moved `run.stage`, while the guards read
`session.gates`, which only ever carried `invariants`. The workflow could not
reach `commit`, and the bridge that was supposed to close that gap
(`gateMapping`) was declared in the schema and read by no one.

Two words for one idea also produced two implementations of the same field:
`allowedAgents` on a phase compared against an agent id the host never supplies
and therefore blocked every mutation, while on a stage it compared against the
dispatched agent and worked. One rule, one implementation, one behaviour.

## `gates:` on a stage — one field, whole contract

Its presence says all of it:

- the stage is a verifier: its agent must finish with a `<workflow-result>` tag;
- the tag names one of the stage's gates — several agents may work in one stage
  (review and qa in parallel), so a tag names what it verifies, never the stage
  it ran in; a name the stage does not declare is a recorded refusal, not a
  silent no-op;
- `pass` sets that gate to `passed`, `fail` sets it to `failed`, which is what
  the retry transitions above read; the stage is passed when every gate it
  declares is passed, and failed as soon as one fails;
- a gate named here that no session carries is a schema **load** error, caught
  by `compileWorkflow`, not silence at runtime.

`gateMapping` and the schema-level `verifiers:` list both disappear into it.

## Gates belong to whatever they verify

A gate on an inner stage is a fact **about one task**, so it lives on that
task's run, and guards inside the loop read `task.gates`. A gate on an outer
stage is a fact about the session and lives where it does today.

This is not a detail. With `dispatch: parallel` three tasks run at once; a
session-wide `review` gate would let the first task that passes review close the
stage on behalf of the other two. A gate is evidence about the work it was
produced for.

The outer stage closes when its loop does — every task completed — which is
what `allTasksCompleted()` already means.

## Reset

Starting a mutation clears the gates of the task it belongs to, exactly as it
clears `invariants` today. Otherwise a second edit sails through on the review
approval the first one earned.

## Consequences to carry out

| Area | Change |
|---|---|
| `profile-schema.ts` | `phases` → `stages`; a stage may nest `stages` + `transitions`; `gates: string[]` on a stage; drop `gateMapping`, `verifiers`, `phaseAssignments` naming |
| `session-schema.ts` | `currentPhase` → `currentStage`; `loopRuns[].stage` keeps its meaning; gates move onto the run |
| `engine.ts` | one transition evaluator, applied to a session or to a task run; guard context gains `task` |
| `runtime.ts` | `handleWorkflowResult` sets the stage's gates and refuses a tag whose stage does not match |
| `compile-workflow.ts` | wire it up at last: validate stage references, gate names, and transition endpoints at load |
| profiles | `base.yaml` rewritten in the new model; `task-cycles.yaml` folded into it and un-exampled |
| TUI, dashboard | rename, and show the per-task gates |

Persisted sessions are not migrated: migrations stay ignored until release.
