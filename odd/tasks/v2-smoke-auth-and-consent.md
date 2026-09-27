# V2 Smoke: Auth and Consent

## Objective

Make the V2 host smoke able to reach its assertions at all, and cover the consent path — the
plugin's core mechanism — on V2 with the same kind of evidence the V1 scenarios produce:
durable workflow state read back from the plugin's store.

## Problem

The single V2 scenario could never pass, and the reason it gave was misleading:

1. `POST /api/session` is answered `401` with an empty body and
   `www-authenticate: Basic realm="Secure Area"`. The generated client decodes that empty non-JSON
   body and reports `UnsupportedContentType`, so an authorization failure looked like a
   content-type problem. The V2 host ignores an inherited `OPENCODE_SERVER_PASSWORD`, generates
   its own credential and prints it as `server password <value>`; it accepts it as HTTP Basic with
   the `opencode` user.
2. With the credential sent, every prompt failed with `provider.auth` — `Authentication Error, No
api key passed in.` A fresh V2 data directory never imports the legacy credential file:
   `packages/core/src/database/migration.ts` (`apply`) bootstraps an empty database from the
   current schema and records **every** migration as applied without executing any of them, so
   `20260805200742_import_legacy_credentials` (which reads `auth.json` into the `credential`
   table) imports nothing. With no credential and no configured auth, `model-resolver.ts` forces
   `auth: none` for an api-key provider, and the model call fails before the plugin is reached.
3. Nothing answered the host's forms, which is how a consent question reaches V2: the V1 runner
   polls `/question` over HTTP, and the V2 client had no equivalent of
   `session.form.list` / `session.form.reply`.

## Scope

- `scripts/host-smoke/harness.ts`: read the generated server credential from the host log, expose
  it as `Host.authHeader`, and give a V2 provider entry the key a fresh V2 data directory cannot
  import.
- `scripts/host-smoke/operator.ts` (new): the operator answer policy, shared by both runs.
- `scripts/host-smoke/v2-client.ts`: send the credential, answer forms, bound one prompt, and drive
  it to completion.
- `scripts/host-smoke/v2-scenarios.ts` (new): V2 scenarios stated against durable state.
- `scripts/host-smoke/run.ts`: select and report V2 scenarios through the runner it already has.
- `src/app/v2-tool-surface-adapter.ts`: register the workflow tools under the promise `ToolEditor`
  contract, whose `execute` returns a `Promise`.
- Focused tests for every pure piece.

## Out of Scope

- Blocking the ambient plugins an isolated host still loads from the operator's own config
  directory (for example `openchamber-agent-tool`, which keeps trying to snapshot a location
  outside the project and logs `failed to capture snapshot` about once a second). They are noise in
  the host log, not part of the run: no scenario depends on them and the smoke profile does not
  ship them.

## Constraints

- V1 behavior, V1 scenarios and V1 config loading stay exactly as they are.
- The operator policy keeps its meaning: a consent request gets the requested decision, an
  invented question prefers a declining option.
- No secrets in output, reports or commits; the credential is read programmatically and never
  printed.
- No remote operations, push, or PR.

## Stable Task IDs

- `V2SA-001`: Record the root cause and this task artifact.
- `V2SA-002`: Authenticate the V2 client against the credential the host generated.
- `V2SA-003`: Give the V2 provider entry the key a fresh data directory cannot import.
- `V2SA-004`: Answer V2 consent forms with the shared operator policy.
- `V2SA-005`: State and run V2 scenarios (create, consent, tasks) on durable state.
- `V2SA-006`: Run the required checks and record the receipt honestly.
- `V2SA-007`: Bound one prompt by a budget, and report the budget as the finding when it runs out.
- `V2SA-008`: Register the workflow tools under the promise `ToolEditor` contract.
- `V2SA-009`: Declare the string output schema the V2 runtime requires of a tool that returns `output`.
- `V2SA-010`: Keep the host's own request messages — tool calls and results — and append only what
  the legacy layer injects.
- `V2SA-011`: Run the V2 scenario session as the profile agent V1 sends with every message.

## Acceptance Criteria

1. A V2 client reaches the host: session create and remove succeed against the isolated host.
2. A live prompt in the isolated V2 host reaches the model (no `provider.auth`).
3. A live prompt actually runs the plugin's tool: the model's call returns the tool's output rather
   than `… .then is not a function` or `Tool result declared output without an output schema`.
4. The consent scenario asserts the transition the consent released, read from the plugin's
   persisted session — not from the model's story.
5. A form answer uses the option's value, matched by label, with the tag deciding that this is the
   scenario's own consent.
6. A prompt that outlives `HOST_SMOKE_PROMPT_TIMEOUT_MS` ends its scenario with a `FAIL` naming the
   call and what was pending, instead of waiting forever.
7. V1 scenarios and V1 config loading are unchanged.
8. `mise run check` and `mise run build` pass.

## Checks

- `bun test test/app/host-smoke-harness.test.ts test/app/host-smoke-operator.test.ts test/app/host-smoke-v2-client.test.ts test/app/host-smoke-v2-scenarios.test.ts test/app/v2-tool-surface-adapter.test.ts test/app/v2-plugin-adapter.test.ts`
- `mise run check`
- `mise run build`
- `git diff --check`
- One live attempt: `HOST_SMOKE_OPENCODE_VERSION=v2 mise run smoke`

## Progress

- [x] `V2SA-001` Root cause recorded above, with the source references that establish it.
- [x] `V2SA-002` `serverPasswordFromLogs` + `basicAuthHeader` + `Host.authHeader`; the client
      transport sends the credential and never overrides a caller's own header.
- [x] `V2SA-003` `legacyApiKeyFor` + `withProviderApiKey`, applied only when writing the V2
      config; an entry the operator already keyed is left untouched.
- [x] `V2SA-004` `operator.ts` policy shared by both runs; `planFormAnswer` maps label to the
      option value, arrays for multiselect, defaults for boolean and free text.
- [x] `V2SA-005` `v2-scenarios.ts` with create, consent and tasks scenarios; the runner selects
      them by id, starts a host per scenario, reports PASS/FAIL and exits non-zero on failure.
- [x] `V2SA-007` `promptTimeoutMs` (env, default 60s) bounds the whole prompt — enqueue, wait and
      sweeps; a `PromptTimeoutError` quotes the call and what the host was still waiting on. The
      runner judges a step by the state the plugin persisted, so a temporary overrun bounds the wait
      instead of failing a step that already succeeded, and the report says the turn was still running.
- [x] `V2SA-008` `v2-tool-surface-adapter.ts` returns `Promise<Result>` from `execute`, as the
      promise `ToolEditor` requires; the `as never` cast that hid the mismatch is gone.
- [x] `V2SA-009` every registered tool declares `output: { type: 'string' }`, which is what makes
      the shared surface's `{ output }` result legal under the V2 tool runtime.
- [x] `V2SA-010` `v2MessagesWithInjected` keeps the host's request messages untouched and crosses
      back only the messages the legacy transform added.
- [x] `V2SA-011` the client switches each scenario session to `orchestrator`; the scenario states
      which agent it drives.
- [x] `V2SA-006` Live receipt recorded in `## Live V2 Receipt`: `3/3 passed` on the isolated V2 host.

## Evidence and Decisions

- The credential scheme was established by probing the running host, not by reading the binary:
  no header 401, `Bearer <value>` 401, `Basic opencode:<env value>` 401, `Basic opencode:<value the
host printed>` 200.
- Why the client's error lied: `node_modules/@opencode/client/dist/chunks/service-*.js` decodes a
  response as JSON whenever the status matches, and reports `UnsupportedContentType` for an empty
  body with no JSON media type. A 401 therefore surfaces as a content-type error.
- Where the data directory comes from: `packages/util/src/global-roots.ts` — `XDG_DATA_HOME` plus
  `opencode`, which is where the harness already copies `auth.json`.
- Why that copy is not enough: `packages/core/src/database/migration.ts`, function `apply`, takes
  the empty-database branch and inserts every migration id as completed without running their
  `up`. Confirmed on a live isolated host: 48 migrations recorded, the legacy import among them,
  and `SELECT integration_id FROM credential` empty.
- Why a settings key is enough: `packages/core/src/model-resolver.ts` —
  `hasConfiguredAuth(model)` is true when `settings.apiKey` (or `authToken`/`accessToken`) is a
  non-empty string, which is exactly what prevents the forced `auth: none`, and
  `nativeCredentialSettings` only overrides settings when a stored credential exists.
- Why a live V2 tool call never ran: the host registers promise-flavour plugin tools through
  `executePromiseTool` (`packages/plugin/src/promise/adapter.ts:615`), which wraps the plugin's
  `execute` in `Effect.promise`; that evaluates the thunk and calls `.then` on the result
  (`effect/dist/internal/effect.js:690`). The adapter returned `Effect.tryPromise({…})`, an `Effect`,
  so the call died inside `Effect.promise` with `.then is not a function` before the tool body ran.
  Live evidence: the model's `execute` call returned
  `y(()=>e(r)).then is not a function. (In 'y(()=>e(r)).then((n)=>t(Lt(n)),(n)=>t(ve(n)))', …)`,
  which is the minified `Effect.promise` body with the plugin's Effect where a thenable belongs.
  The promise `ToolEditor` contract is stated where the type is imported
  (`packages/plugin/src/promise/tool.ts:19-24`: `execute(…) => Promise<Tool.Result<Output>>`).
  The `as never` cast in `registerWorkflowTools` is what kept the typechecker quiet about it.
- Why the prompt budget is 60s: one live prompt in the fixed host spent `prompt` 481ms (the host
  enqueues the user message and returns) and `wait` 31 856ms, with no pending permission request
  and no pending form. The budget exists to bound an unbounded wait, not to time the model, so
  ~2x the measured latency is the default and `HOST_SMOKE_PROMPT_TIMEOUT_MS` overrides it.
- What the earlier "hang" was not: the first live probe settled — `session.wait` completes. The
  V2 run was slow (a live model plus per-step retries), and an unbounded client could not tell that
  apart from a wedged host; the budget is what makes the difference reportable rather than fatal.
- Why the budget first expired after the `.then` fix: the tool ran (the workflow session appeared),
  but the model got `Tool result declared output without an output schema` back and re-issued the
  same call — 43 identical `execute` calls in one turn, one per second, so the session never went
  idle. The host's own storage shows the loop (`session_message`, one `assistant` row per call) and
  the guard that caused it: `packages/core/src/tool/runtime.ts` dies when `tool.output === undefined`
  and the result has `output`. The tools declared `input` only. Declaring `output: { type: 'string' }`
  is the fix; the host's `encodeOutput` treats a plain JSON schema as JSON-ness, and Code Mode's
  `decodeOutput` passes a non-Effect schema through unchanged.
- The agent is not the cause of the repetition. With the `.then` bug still present, switching the V2
  session to `orchestrator` (V1 parity) changed nothing: the same loop, the same failure to settle.
  The lock is why `session.context` appeared to hang while the loop ran — the session's generation
  never yielded. The V2 client therefore still sends no agent, and the scenarios are judged by
  persisted state rather than by an agent's willingness to stop.
- Why the model repeated the call even after it succeeded: the V2 context bridge replaced the host's
  request messages with a text-only projection of the legacy list (`v2-plugin-contract.ts`,
  `v2MessagesFromLegacy`), so every `tool-call`, `tool-result` and `reasoning` part left the request
  (`@opencode/ai` `Message` parts; `packages/plugin/src/promise/session.ts:28-33`). The model could not
  see that it had already called the tool. Live evidence after the `.then` fix: 26 assistant steps in
  one turn, the first an `execute` that created the session, the rest repeats and name guesses.
  `v2MessagesWithInjected` keeps the host's messages and appends only the messages the legacy layer
  pushed (`rules/rule-delivery.ts`, `deliverTransientDispatch` — the layer is additive).
- A V2 agent keeps working after the call it was asked for. With the bridge fixed, one live prompt
  created the session and then went on reading `plan.md`, the profile schema and the task list. So the
  step is now judged by the state the plugin persisted, and the prompt budget only bounds the wait —
  the V1 scenarios' `session.wait` analogue would have failed a step that had already succeeded.
  Verified by probe, not assumed: `readWorkflowSession` held `planning` while the turn was still going.
- Agent parity is the third requirement, and the plugin's own log says so: with the session left on
  the host default, `workflow-tasks-set` was called and refused —
  `Refused workflow-tasks-set {"agent":"build","allowed":["orchestrator"]}` — so `tasks` stayed `{}`
  and the stage stayed `tasks_ready`. V1 sends `agent: "orchestrator"` on every message; V2's prompt
  has no such field, so the client switches the session's agent after creating it. Verified live:
  with the switch, the same instruction settles in 3.3s and the session reaches `planning`.

## Live V2 Receipt

`HOST_SMOKE_OPENCODE_VERSION=v2 HOST_SMOKE_ATTEMPTS=1 mise run smoke` (2026-09-27, host
`opencode-v2 2.0.16`, model `crpt/deepseek-ai/DeepSeek-V4-Flash-small`, profile `smoke`):

| Scenario              | Result | Attempts | Duration | Evidence                                        |
| --------------------- | ------ | -------- | -------- | ----------------------------------------------- |
| `v2-workflow-create`  | PASS   | 1        | 3.7s     | durable state reached `planning`                |
| `v2-workflow-consent` | PASS   | 2        | 8.1s     | consent answered as a form; state `tasks_ready` |
| `v2-workflow-tasks`   | PASS   | 3        | 10.3s    | task list set; state `execution`                |

`3/3 passed`, exit 0. `attempts` counts prompts across a scenario's steps, so 1/2/3 means every step
succeeded on its first prompt — no retries. The consent scenario is the one that matters: its
`tasks_ready` can only be reached through the tag → form → `form.reply` path, and the durable session
carries the granted `plan` approval as evidence.

Not yet closed:

- V1 regression on the same build: a short subset (`create`, `task-control`) was run after these
  changes; the full V1 set was not re-run in this task.
- The step is judged by the state the plugin persisted, so a step could in principle pass on a state
  a previous step's autonomous continuation reached. Nothing in these three scenarios distinguishes
  it today; recording the pre-step state in the evidence would.

## Mirror State

Pending full-document mirror to Engram topic `odd/v2-smoke-auth-and-consent/tasks`; `mem_save` is
refused while several active runtime sessions match this checkout. The exact state remains this
file.
