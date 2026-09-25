# V2 Runtime Host Adapter

## Objective

Replace the V2 adapter's empty `RuntimeContext.client` with an explicit,
host-neutral capability boundary while preserving existing V1 behavior.

## Problem

The V2 adapter currently passes `client: {}` into the shared runtime. This
silently disables or degrades consent history checks, synthetic rule delivery,
host-session listing, tool/MCP discovery, logging, and reporting.

## Scope

- Introduce a `RuntimeHostAdapter` capability interface.
- Keep V1 SDK request/response shapes inside a V1 adapter.
- Add a V2 adapter only for semantics confirmed by the OpenCode V2 source.
- Migrate shared consumers away from direct `RuntimeContext.client` access.
- Preserve explicit optional-capability behavior where V2 has no safe equivalent.
- Add focused adapter, runtime, consent, rules, and V2 integration tests.

## Constraints

- Do not guess V2 `noReply` semantics.
- Do not map `mcp.list()` to V1 connected-status semantics without evidence.
- Do not change consent fail-open/fail-closed policy incidentally.
- Preserve existing user changes under `openspec/`.
- Keep V1 and V2 SDK shapes out of shared application code.

## Tasks

- [x] V2-001 Define neutral host capability types and document missing-capability semantics.
- [x] V2-002 Implement V1 adapter and migrate shared runtime construction.
- [x] V2-003 Implement confirmed V2 capabilities: parent lookup and tool discovery.
- [x] V2-004 Migrate rules tool discovery and history consumers to neutral host operations.
- [ ] V2-005 Add adapter and consumer tests, preserving V1 request-shape assertions at the adapter boundary.
- [ ] V2-006 Verify typecheck, tests, build, and V2 host smoke; record failures honestly.

## Acceptance criteria

- No V2 runtime is constructed with `client: {}`.
- Shared runtime consumers depend on neutral operations, not V1 SDK namespaces.
- V1 behavior remains covered through a dedicated V1 adapter.
- V2 exposes only confirmed safe capabilities; unsupported operations are explicit.
- Tests demonstrate behavior with full, partial, and absent optional capabilities.
- Required checks and any environmental failures are recorded in this document.

## Verification

- `mise run typecheck`
- `bun test test/app/v2-plugin-adapter.test.ts test/app/consent-orchestrator.test.ts`
- `bun test`
- `mise run build`
- `mise run smoke`

## Progress

Completed V2-001 through V2-004. The shared runtime now accepts a
`RuntimeHostAdapter`; V1 retains an SDK-shaped adapter, while V2 provides
confirmed parent lookup and tool discovery. V2-004 migrated rules tool discovery
and history reads to neutral host operations. V1 keeps directory-scoped `tool.ids`,
MCP connected-capability mapping, and `session.messages` response normalization
inside the adapter boundary. V2 history remains unsupported because the checked-in
V2 plugin contract exposes no message-list operation, so the runtime preserves its
fail-open empty-history behavior. Synthetic/prompt delivery, consent, logging,
reporting, mutation listing, and host-session listing remain intentionally
unmigrated because their V2 semantics are not proven here.

Verification evidence:

- `bunx tsc --noEmit`: passed.
- `mise run typecheck`: passed.
- `mise run lint`: passed with existing `no-explicit-any` warnings.
- focused adapter and V2 adapter tests: 20 passed, 0 failed.
- `mise run build`: passed, including build verification.
- `git diff --check`: passed.

## Next step

Implement V2-004 in separate consumer slices. Start with rules discovery and
history/delivery capabilities; do not change consent injection semantics until
V2 synthetic delivery is confirmed.
