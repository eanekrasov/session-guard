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

`profile.json.extends` builds a chain, and every schema file across that chain is
resolved. The list is merged **last wins**, root first, so a profile's own schema
overrides what it inherits. Transitions merge per `from→to`, stages per phase id,
action guards per action; `requiredGates` is replaced wholesale.

Write a derived schema as a delta: declare only what differs.

## Known traps

**`allowedAgents` is enforced at task admission only.** Agent identity reaches
the plugin in exactly one place: the `subagent_type` of a `task` call. So
`allowedAgents` is checked in `tool.execute.before` for `task`, against the
stage's list or, when the stage declares none, the phase's. A phase without
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
write it closes its own phase without evidence. Workers report outcomes; the
orchestrator records them.

`workflow.tasks-get` stays open — reading is not control.

Names follow the usual rule: a bare name (`orchestrator`) and the qualified form
the host reports (`android/orchestrator`) both match, another profile's
qualified name never does.
