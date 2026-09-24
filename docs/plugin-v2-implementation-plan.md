# V2 Plugin Implementation Plan

> **Context:** plugin development.
>
> **Load when:** implementing the V2 OpenCode plugin entrypoint and its runtime integration.
>
> **Do not use for:** user-facing plugin configuration or profile authoring.
>
> **Related documents:** [plugin-architecture.md](plugin-architecture.md), [usage.md](usage.md).

## 1. Objective

Implement `SessionGuardPluginV2` as a first-class OpenCode V2 plugin while retaining the
V1 entrypoint in the package export. The two entrypoints are intentional: OpenCode supports
both plugin generations, and V1 does not need feature parity while V2 is being developed.

The implementation must reuse the existing application and domain behavior rather than
creating a second workflow engine. Host-specific differences belong in the entrypoint
adapters; session, policy, workflow, and persistence rules remain shared.

## 2. Current state

### V1 entrypoint

`src/index.ts` currently exports `SessionGuardPluginV1`, which:

1. receives `PluginInput` from `@opencode-ai/plugin`;
2. resolves the project profile directory and global runtime directory;
3. creates those directories defensively;
4. constructs the shared runtime through `createRuntime(ctx, paths)`;
5. returns the V1 `Hooks` object.

The V1 runtime is already responsible for the application behavior exposed through:

- `config`;
- custom tools;
- `chat.message`;
- `tool.execute.before`;
- `tool.execute.after`;
- `event`;
- system/message transforms;
- compaction;
- disposal.

### V2 entrypoint

`SessionGuardPluginV2` now constructs the shared runtime and registers the implemented V2
slice: `execute.before`, `execute.after`, the read-only `workflow-list` tool transform, session
parent lookup, and cleanup of registrations and runtime-owned resources. This is not V1 feature
parity: host events, chat message processing, compaction, and message transforms remain deferred
until their V2 mappings are explicitly verified.

### V2 host contract

The installed `@opencode/plugin` promise API provides:

- `Plugin.define({ id, setup })`;
- `Context` with domain objects such as `tool`, `session`, `event`, `storage`, and `location`;
- `ctx.tool.hook(name, callback)` registrations;
- disposable registrations;
- a setup-level `Cleanup` function.

V2 tool events are not the same shape as V1 hook arguments. The adapter must translate the
V2 event contract explicitly instead of casting a V2 context to `PluginInput`.

## 3. Architectural decision

Use two host entrypoints over one shared application runtime:

```text
V1 host API ──> V1 adapter ──┐
                             ├──> SessionGuard runtime ──> domain/session/schema
V2 host API ──> V2 adapter ──┘
```

The two runtime entrypoints are a supported product shape, not a temporary migration
accident. Their lifecycle and registration mechanisms may differ, but they must converge on
the same policy and persistence implementation wherever the host contracts provide the
required capability.

The V2 implementation is allowed to be incomplete relative to V1 during development. Its
scope is governed by the V2 host capabilities and the explicitly selected implementation
slice; missing V2 capabilities must be documented and tested as unavailable rather than
silently emulated.

## 4. Design constraints

### 4.1 Shared behavior

Do not duplicate or reimplement:

- profile resolution;
- workflow schema compilation;
- session loading and persistence;
- session locking and queueing;
- guard evaluation;
- task admission;
- consent processing;
- mutation lifecycle;
- result validation and transition logic.

The V2 layer may coordinate registrations and translate host events, but it must not become a
second policy engine.

### 4.2 Host isolation

Avoid passing `PluginInput` or V2 `Context` below the adapter seam. The runtime should consume
the smallest internal host contract needed by the application layer. If a full extraction is
too large for the first slice, introduce a V2-specific adapter around the existing runtime
and record the remaining coupling as follow-up work.

### 4.3 Project isolation

V2 must resolve paths for the current project instance and must not write calculated defaults
into `process.env`. The V1 path behavior is the reference for:

- project-local profiles;
- global session storage;
- operator overrides;
- multiple plugin instances in one process.

### 4.4 Cleanup

Every V2 registration must be retained and disposed exactly once. Cleanup must be safe when:

- setup fails partway through registration;
- a registration rejects during disposal;
- setup is called more than once by the host;
- no registration was created.

Cleanup errors must be logged through the plugin's established error/reporting path without
masking the original setup failure.

### 4.5 No speculative compatibility

Do not manufacture V2 equivalents for hooks that are not present in the installed host
contract. For each V1 capability, classify it as:

- implemented through a direct V2 mapping;
- implemented through a documented V2-specific mapping;
- deferred because the V2 host has no supported equivalent;
- intentionally out of scope for the current V2 slice.

## 5. Proposed module structure

The final structure should be:

```text
src/index.ts                       # exports both V1 and V2 entrypoints
src/app/runtime.ts                 # shared SessionGuard application runtime
src/app/runtime-hooks.ts           # current V1 hook assembly
src/app/v1-plugin-adapter.ts       # V1 context/path adaptation, if extracted
src/app/v2-plugin-adapter.ts       # V2 registrations and cleanup
src/app/runtime-host.ts            # internal runtime dependency contract, if needed
test/app/plugin-v2.test.ts         # V2 lifecycle and registration tests
test/app/plugin-v2-adapter.test.ts # event mapping and cleanup tests, if separated
```

The first implementation slice may keep small adapter code in `src/index.ts` if that avoids
premature indirection. Once more than one V2 registration or one event translation exists,
move the adapter into `src/app/v2-plugin-adapter.ts`; this keeps the public entrypoint thin
and makes cleanup and mapping independently testable.

## 6. Implementation phases

### Phase 0 — Confirm the V2 host contract

Before source changes, verify the exact installed declarations and runtime behavior for:

- `Plugin.define` and setup lifecycle;
- `Context.location` and project/worktree identity;
- `ctx.tool.hook` event names and payloads;
- `ctx.tool.transform` and custom tool registration;
- `ctx.event.subscribe`;
- `ctx.session` hooks and session lookup;
- storage and logging facilities;
- registration disposal behavior.

Record any capability that cannot be mapped. Do not infer a V2 hook from a similarly named
V1 hook.

**Exit criteria:** the adapter input/output table in Phase 1 is complete and every deferred
capability has an explicit reason.

### Phase 1 — Define the adapter contract

Create a small internal contract for the runtime-facing information required by V2. At
minimum, define:

- project directory;
- worktree directory, if the runtime needs it;
- profile directory;
- session store directory;
- session lookup needed for parent resolution;
- logging/reporting access;
- tool execution identity and arguments;
- tool result/error representation.

Prefer existing exported types. Do not create duplicate session, tool, or workflow DTOs when
an existing type can be reused or safely projected with `Pick`/`Omit`.

**Exit criteria:** the V2 adapter no longer needs to cast a `Context` to `PluginInput`, and
the runtime-facing contract is narrower than either host API.

### Phase 2 — Extract or reuse runtime construction

Refactor runtime construction so both entrypoints can create the same application runtime.
Preserve the current V1 behavior while changing only the construction seam.

The construction path must:

1. resolve paths per plugin instance;
2. create required directories;
3. initialize stores and orchestrators once;
4. retain host client access only behind the adapter contract;
5. expose the application operations needed by V2 hooks;
6. preserve disposal of runtime-owned resources.

If a broad extraction would delay V2 unnecessarily, first add a narrow V2-compatible
construction function and schedule removal of the remaining V1-specific coupling as a
follow-up task.

**Exit criteria:** V1 tests remain green and V2 can construct the shared runtime without
instantiating a fake V1 `PluginInput`.

### Phase 3 — Implement V2 `execute.before`

Register `ctx.tool.hook('execute.before', ...)` and translate its event into the runtime's
before-execution operation.

The adapter must preserve:

- tool name;
- host session ID;
- call ID;
- agent/message identity where available;
- raw tool input;
- rejection behavior.

Workflow blocks must be propagated through the V2 hook in the host-supported way. Do not
convert a block into a log-only result.

**Exit criteria:** a V2 before hook blocks a disallowed operation, allows an allowed operation,
and does not affect unrelated sessions.

### Phase 4 — Implement V2 `execute.after`

Register `ctx.tool.hook('execute.after', ...)` and translate both completed and failed tool
events into the runtime's after-execution operation.

Handle explicitly:

- completed result extraction;
- failed tool calls;
- result metadata availability;
- output sanitization;
- mutation finish and workflow-result processing;
- stale or missing call identity.

If the V2 result object cannot represent a V1 field, add an internal optional field or a
V2-specific result adapter; never fabricate a value that changes policy semantics.

**Exit criteria:** successful and failed V2 tool calls close their lifecycle correctly, and
the runtime does not leave an operation pending after either path.

### Phase 5 — Add V2 tools and supported event integrations

Map the existing workflow tool surface to V2's tool registration/transform API only after
the core before/after lifecycle is stable.

Then implement supported mappings for:

- event subscription;
- session parent lookup;
- message/session hooks available in V2;
- cleanup of every registration.

The current capability boundary is documented below and characterized by focused tests. Remaining
Phase 5 work is limited to mappings that the installed V2 contract confirms; no unsupported V1
behavior may be emulated.

**Current-slice exit criteria:** every implemented V2 registration has a test reference and every
deferred capability has an explicit reason. **Remaining Phase 5 exit criteria:** any additional
V2 mapping is confirmed by the installed contract, implemented, and characterized without
inventing a host API.

### Phase 6 — Harden lifecycle and failure handling

Add tests for:

- setup with zero registrations;
- failure during the second registration;
- cleanup after partial setup;
- repeated cleanup;
- disposal failure;
- multiple V2 plugin instances for different projects;
- concurrent tool events for one session;
- unrelated sessions and worktrees;
- host event payloads with optional fields absent.

**Exit criteria:** no leaked registration, no cross-project path reuse, and deterministic
behavior for partial setup and cleanup failures.

### Phase 7 — Host integration verification

Run unit tests first, then build the package, then run host smoke checks against the actual
OpenCode V2 loading path. The V2 smoke test must verify behavior, not only that setup logs
appear.

**Exit criteria:** the package builds, required declarations and entrypoints are distinct,
V2 setup loads in the host, and at least one blocked and one allowed operation are observed
through the real integration path.

## 7. Current V2 capability matrix

`V2_CAPABILITIES` in `src/app/v2-plugin-contract.ts` is the source of truth. The focused contract
test verifies that every supported entry resolves to its test path and every deferred entry keeps
an explicit reason.

| Capability              | V1 source                              | V2 mapping / status                                  | Deferred or out-of-scope reason                        | Test path                            |
| ----------------------- | -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| Tool before policy      | `tool.execute.before`                  | `ctx.tool.hook('execute.before')` — supported        | —                                                      | `test/app/v2-plugin-adapter.test.ts` |
| Tool after lifecycle    | `tool.execute.after`                   | `ctx.tool.hook('execute.after')` — supported         | —                                                      | `test/app/v2-plugin-adapter.test.ts` |
| Custom workflow tools   | `hooks.tool`                           | `ctx.tool.transform` (`workflow-list`) — supported   | —                                                      | `test/app/v2-plugin-adapter.test.ts` |
| Session parent lookup   | V1 client session API                  | `ctx.session.get({ sessionID })` — supported         | —                                                      | `test/app/v2-plugin-adapter.test.ts` |
| Host events             | `event`                                | `ctx.event.subscribe` — deferred                     | Event subscription is not part of the V2.1/V2.2 slice. | —                                    |
| Chat message processing | `chat.message`                         | No confirmed V2 equivalent — deferred                | The installed contract has not been explicitly mapped. | —                                    |
| Compaction              | `experimental.session.compacting`      | No confirmed V2 equivalent — deferred                | The installed contract has not been explicitly mapped. | —                                    |
| Message transform       | `experimental.chat.messages.transform` | No confirmed V2 equivalent — deferred                | The installed contract has not been explicitly mapped. | —                                    |
| Runtime disposal        | `dispose`                              | Setup cleanup and `Registration.dispose` — supported | —                                                      | `test/app/v2-plugin-adapter.test.ts` |

## 8. Verification commands

For source/runtime changes, run:

```bash
mise run check
mise run build
```

For host integration changes, additionally run:

```bash
mise run smoke
```

For focused development, use the relevant V2 tests through Bun, for example:

```bash
bun test test/app/plugin-v2.test.ts
```

After build, verify that:

- `dist/index.js`, `dist/cli.js`, and `dist/tui.js` remain distinct;
- declarations have source files;
- no generated output was edited manually;
- `git diff --check` is clean.

## 9. Risks and mitigations

### Different result semantics

V2 `execute.after` exposes a result/error union rather than the V1 output shape.

**Mitigation:** use an explicit result adapter with tests for completed and failed calls.

### Missing V2 equivalents

Some V1 hooks may not exist in V2.

**Mitigation:** maintain the capability matrix; defer unsupported behavior explicitly instead
of inventing host APIs or silently claiming parity.

### Double registration or double execution

The package exports both V1 and V2 entrypoints, and a host configuration could load more than
one surface.

**Mitigation:** test the supported loading combinations, make runtime ownership explicit,
and avoid global singleton state. Do not assume that separate entrypoints imply safe duplicate
registration without verifying host behavior.

### Runtime coupling to V1 types

The current constructor accepts `PluginInput` directly.

**Mitigation:** extract the smallest runtime dependency contract, or isolate temporary V1
coupling in a clearly named adapter with a follow-up removal task.

### Partial setup failure

V2 registration is incremental and can fail after earlier registrations succeeded.

**Mitigation:** transactional registration helper; dispose already-created registrations in
reverse order before rethrowing the original setup error.

## 10. Definition of done

- `SessionGuardPluginV2` constructs and registers the shared runtime behavior.
- V1 and V2 remain separate supported plugin entrypoints.
- V2 does not fake a V1 `PluginInput` through unsafe broad casting.
- V2 before and after hooks preserve session/call identity and workflow block semantics.
- V2 cleanup disposes every registration and is safe on partial setup.
- Project paths and stores remain isolated per plugin instance.
- Unsupported V2 capabilities are documented in the capability matrix.
- Focused V2 tests pass.
- `mise run check` passes.
- `mise run build` passes.
- `mise run smoke` passes when host integration is changed.
- No unrelated behavior or generated artifact is modified.
