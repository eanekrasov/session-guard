# Proposal: Plugin Runtime (P0 + Dashboard Skeleton)

## Intent

Connect the Domain Layer and Data Layer into a working OpenCode plugin. Currently the plugin can load configs and manage sessions in isolation — there is no entry point that wires SDK hooks to domain logic. Without this, the plugin is useless: no OpenCode command triggers the state machine.

## Scope

### In Scope
- `createRuntime(context: PluginInput): Hooks` — factory entry point
- `plugin-runtime.js` — bridge file for the OpenCode plugin loader (`plugins/session-guard.js`)
- Hooks: `tool.workflow.create`, `chat.message`, `tool.execute.before`, `tool.execute.after`, `event`, `dispose`
- Session enqueue (serial per-root-session queue)
- `SessionGuardRuntime` — internal class with state (store, engine cache, liveMutations map, sessionQueue map)
- SSE Dashboard server skeleton (Bun HTTP, `/status` endpoint)
- Graceful startup/shutdown

### Out of Scope
- Dashboard contract types / full dashboard UI — P1
- Beads bridge — P2
- Guardrails & Consent protocol — P2
- Change scope / SDD artifacts — P2

## Capabilities

### New Capabilities
- `plugin-runtime`: OpenCode plugin entry point, hooks wiring, session lifecycle

### Modified Capabilities
- None

## Approach

`createRuntime(ctx)` creates a `SessionGuardRuntime` with:
1. `WorkflowStore` + lazy `SessionGuardEngine` cache by `profileId`
2. `sessionQueues: Map<string, PromiseChain>` — serial enqueue per rootSessionId
3. `liveMutations: Map<callId, rootSessionId>` — tracking active mutations
4. Hooks are registered and returned as a `Hooks` object

**File structure:**
- `src/app/runtime.ts` — SessionGuardRuntime class + createRuntime
- `src/app/runtime-types.ts` — types for runtime (Hooks-compatible)
- `src/app/dashboard.ts` — SSE Dashboard server skeleton
- `src/app/index.ts` — barrel export
- `plugins/session-guard.js` — bridge file

### Hook wiring (MVP)
| Hook | Response |
|------|----------|
| `tool.workflow.create` | Creates a session, saves to store |
| `chat.message` | Checks session, displays phase |
| `tool.execute.before` | Checks guards, begins mutation |
| `tool.execute.after` | Processes result, finishes mutation |
| `event` | Listens for `message.part.updated` with errors |
| `dispose` | Stops dashboard, cleans up resources |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/app/runtime.ts` | New | Runtime class + factory |
| `src/app/runtime-types.ts` | New | Type definitions |
| `src/app/dashboard.ts` | New | SSE server skeleton |
| `src/app/index.ts` | New | Barrel export |
| `plugins/session-guard.js` | New | Bridge file |
| `src/index.ts` | Modified | Export createRuntime |
| `package.json` | Modified | Possibly exports entry |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Plugin SDK API incompatible with Bun runtime | Low | SDK already used in parent |
| Serial queue may block parallel operations | Med | Per-root queue, not global |
| SSE server may crash on port conflict | Low | Graceful fallback, port from env |

## Rollback Plan

- Delete `plugins/session-guard.js`
- Remove `createRuntime` export from `src/index.ts`
- Revert `package.json`

## Dependencies

- `@opencode-ai/plugin` v1.x (already in parent's dependencies)
- `src/domain/` — domain module (ready)
- `src/session/` — session module (ready)

## Success Criteria

- [ ] `createRuntime` returns valid `Hooks` object
- [ ] `workflow.create` tool creates valid session
- [ ] `tool.execute.before` correctly gates mutation
- [ ] Session state persists after mutations
- [ ] Build passes (bun build)
