# V1 SSE: tracking the session tree

> **Context:** plugin development / host smoke transport.
>
> **Load when:** investigating V1 SSE lifecycle and session cleanup.
>
> **Do not use for:** defining the OpenCode V1 protocol; the OpenCode source schema is authoritative.
>
> **Related documents:** `smoke/src/host/v1-exchange.ts`, `smoke/src/host/session-events.ts`.

## Idea

Track the current session tree in the V1 SSE handler:

1. Seed the set with the root session ID.
2. Add child IDs from `session.created` when their `parentID` belongs to the tracked tree.
3. Remove IDs from `session.deleted`.
4. Stop the SSE subscription when the tracked set becomes empty.

```ts
const trackedSessionIds = new Set([rootSessionId]);

// session.created: add a child only when its parent is tracked
// session.deleted: remove the matching sessionID
// when trackedSessionIds.size === 0: subscription.stop()
```

## Why it helps

The set provides a useful observed snapshot of the session tree and gives the
transport a defensive cleanup path when the server deletes the last tracked
session. It is a lifecycle-safety mechanism, not a fix for `ConnectionRefused`.

## Boundaries

- Do not remove a session on `session.status: idle`; idle occurs after each prompt.
- Do not stop the parent stream when only a child session is deleted.
- Scope deletion handling to the tracked tree; ignore unrelated sessions.
- Treat the set as observed state, not authoritative liveness: SSE may connect
  after `session.created` or miss an event during reconnect.
- If reconnect support is added, rebuild the set from the session API before
  relying on it for cleanup.

## Protocol fact

OpenCode V1 defines `session.deleted` with `sessionID` and `info`. The current
smoke parser unwraps the event properties into `event.data`, so the deletion
ID is available as `event.data.sessionID`.

## Follow-up

Add focused tests for child deletion, root deletion, unrelated deletion, and
automatic stop after the last tracked session disappears.
