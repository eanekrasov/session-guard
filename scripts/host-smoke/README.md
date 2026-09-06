# host-smoke — the plugin against a real opencode

```bash
bun run smoke              # every scenario
bun run smoke git-block    # one scenario by id
```

Nothing here calls into the plugin. Each scenario starts a real `opencode
serve` in a throwaway project, drives it with a live model through the HTTP
API, and asserts on what the host and the plugin actually did — the session the
plugin persisted, and the tool parts the host recorded. A scenario that passes
here is evidence the mechanism works in production.

## What it isolates, and what it borrows

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` point
at a temp tree, so your own agents, plugins, MCP servers and sessions take no
part in the run. Two things are borrowed from your setup, because without them
there is no live model: the `provider` block from your opencode config, and
`auth.json`. Both land in the temp tree and go away with it.

The project the host runs in is a fresh git repository holding the smoke
profile, `commit-task.ts` and a plan file. It is deleted when the run ends.

## The model is part of the test

A live model decides whether to call the tool it was told to call, so a step can
fail because the model ignored the instruction rather than because the plugin
misbehaved. Every step is retried (`HOST_SMOKE_ATTEMPTS`, default 3) and the
report records how many attempts it took. **A step that needed retries is a
prompt problem; a step that never succeeded is a finding.**

## Environment

| Variable | Meaning |
|---|---|
| `HOST_SMOKE_MODEL` | model id; defaults to the `model` in your opencode config |
| `HOST_SMOKE_PLUGIN` | skip the build and load this path instead of `dist` |
| `HOST_SMOKE_ATTEMPTS` | retries per step, default 3 |
| `HOST_SMOKE_DEBUG` | print consent questions and the host log for failures |

## Things this run established about the host

- A plugin loads from a `file://` **directory** (`file://…/dist`), the form an
  operator writes in their own config. A packed `.tgz` behind a `file://` spec
  is **not** loaded — worth knowing before shipping that way.
- The host reads its agent roster once, at startup, so profile agents must be
  in place before the server comes up.
- The `question` tool — the whole consent path — is only registered for
  interactive clients unless `OPENCODE_ENABLE_QUESTION_TOOL` is set, and is
  denied by default without `permission: { question: "allow" }`.
- `ToolContext.agent` really does carry the calling agent's name, which is what
  `taskControlAgents` is enforced against.

## Findings this run produced

| Finding | Status |
|---|---|
| `workflow.tasks-set` reported success while persisting nothing — a reentrant write overwritten by the outer save | fixed (`SessionQueue`) |
| the consent tag carried a `revision` its own manifest did not, so the plugin's own parser rejected it | fixed (`workflow.consent`) |
| the answer handler looked for the consent tag in the tool's output instead of the question | fixed (`ConsentOrchestrator.after`) |
| nothing in `src` ever sets the `review` or `qa` gate, so the shipped base machine cannot reach `commit` | open — pinned by the `machine-limit` scenario |
