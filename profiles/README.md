# Profiles

A profile is a directory with `profile.json`, one or more schema YAML files, and
optional agent prompts.

## Layout

```
profiles/
  base/      profile.json + base.yaml       — canonical workflow, everything extends it
  harness/   profile.json + harness.yaml    — delta: TypeScript self-edit
  android/   profile.json + android.yaml    — delta: Android
             agent/*.md                     — agent prompts (agentsDir: "agent")
             task-cycles.yaml               — unregistered example, see its header
```

A reference schema with every supported field lives in
`docs/examples/workflow-schema.example.yaml`. It is documentation, not a loaded
profile.

## Schema resolution

A profile may hold as many schemas as it likes, and they are **independent
workflows**. A session runs exactly one of them, named as
`<profileId>/<schemaId>` when it is created; the schema id is the file name
without its extension, and it has to be unique only inside its own profile.

Two schemas become one **only through `extends`**, declared at the top of the
schema file as `<profileId>/<file>`. That profile must be on the chain
`profile.json.extends` builds. Schemas sitting side by side in one profile
never merge — that is the whole point of the id.

Merging a schema onto the one it extends is last-wins per entry: transitions
merge per `from→to`; a stage merges field by field, and its nested stages and
transitions merge by the same rule at any depth; action guards merge per
action; `requiredGates` is replaced wholesale.

Write a derived schema as a delta: declare `extends`, then only what differs.
Naming a stage refines it — a child that pins a roster keeps the loop, nested
stages and transitions its parent declared for that stage.

`profile.json.extends` still governs metadata (agents, skills, invariants,
directories) and is what makes a parent's schema files reachable by name. A
profile that declares no `schemas` of its own inherits the nearest ancestor's
list.

## The stage model

There is one unit of workflow state: the **stage**. A stage that names a task
list in `loop:` runs its own `stages` once per task, moved by its own
`transitions`. Nesting is the only difference between an inner stage and an
outer one: `gates`, `transitions`, guards, effects and retry budgets mean the
same at either level. `allowedAgents` is the exception — it is read only at
task admission, so outside a loop it is inert. See "Known traps" below.

`gates:` on a stage declares what it waits for. Its agents finish with a
`<workflow-result>` whose `stage` field names one of those gates — never the
stage they ran in, because several agents may run in one stage (review and qa
in parallel). The stage passes when every gate it declares passes, and fails as
soon as one fails. Inside a loop those verdicts live on the task's own run;
outside it they are the session's gates.

Full model: `docs/stage-model.md`. Target workflow: `docs/stage-model-plan.md`.

## Known traps

**`allowedAgents` is enforced at task admission only.** Agent identity reaches
the plugin in exactly one place: the `subagent_type` of a `task` call. So
`allowedAgents` is checked in `tool.execute.before` for `task`, against the
nested stage's list or, when it declares none, its parent's. A stage without
`stages` never reaches that check, so a roster there is inert.

**Agent names carry the profile prefix, and resolution handles it.**
`syncProfileAgents` copies `profiles/<id>/<agentsDir>/*.md` into
`.opencode/agents/<id>/`, and OpenCode derives an agent's name from the path
under `agent/` or `agents/` — so `code.md` registers as `<id>/code`. Schemas stay
authored with bare names; the resolver qualifies them (`src/app/agent-names.ts`),
and a dispatch matching either form is accepted. A name qualified by a different
profile never matches.

**`editingAgents` and `verifiers` are declarative only.** They are carried
through the loader and resolver but no check reads them.

## Committing

`scripts/commit-task.ts` is the committing step. The plugin recognises it by
name, checks `canCommit` before it runs, and writes `deliveryReceipt` only after
HEAD actually moved — which is what releases `commit → done`.

## Who may change workflow task state

`workflow.tasks-set`, `workflow.tasks-set-status` and
`workflow.tasks-resolve-decision` are refused for every agent except the ones a
schema names in `taskControlAgents` (default: `orchestrator`). The calling agent
comes from `ToolContext.agent`, which the host populates from the real agent
name — a caller the host does not name is refused too.

The reason is the same one behind the delivery permit: task status is exactly
what `allTasksCompleted()` and `hasPendingTasks()` read, so an agent that can
write it closes its own stage without evidence. Workers report outcomes; the
orchestrator records them.

`workflow.tasks-get` stays open — reading is not control.

Names follow the usual rule: a bare name (`orchestrator`) and the qualified form
the host reports (`android/orchestrator`) both match, another profile's
qualified name never does.
