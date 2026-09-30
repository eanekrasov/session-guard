# Session-Scoped SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one SSE subscription for the lifetime of each smoke session and route prompt, form, terminal, and state-change waits through it.

**Architecture:** Add a session-owned event stream inside each transport adapter. The stream has one reader loop, session-tree filtering, pending waiters, explicit EOF/error propagation, and deterministic shutdown. `createSession` starts it; `removeSession` stops it before deleting the remote session. The runner keeps its state-poll budget by passing a deadline/abort signal to the wait operation.

**Tech Stack:** TypeScript, Bun test, native `fetch`/`ReadableStream`, generated OpenCode V2 client, V1 HTTP/SSE adapter.

**Spec:** Approved chat design: session-scoped SSE; V1/V2 terminal events; no prompt execution timeout; EOF/error before the expected terminal event is explicit; forms and child sessions remain supported; state polling remains budgeted.

## Global Constraints

- Do not reintroduce prompt or execution timeouts.
- A session stream must be closed before the remote session is removed.
- Every pending waiter must settle when the stream ends or fails.
- State polling must still respect `HOST_SMOKE_STATE_POLL_MS`.
- Preserve existing V1/V2 normalized transport contracts.
- Keep the current working tree uncommitted.

---

### Task 1: Define the session event-stream interface

**Files:**

- Create: `smoke/src/host/session-events.ts`
- Test: `smoke/test/session-events.test.ts`

**Interfaces:**

- Produces `SessionEventStream<TEvent>` with `waitFor(predicate, signal?)`, `dispatch(event)`, `fail(error)`, and `close()`.
- Produces `withAbortSignal(signal, promise)` or an equivalent internal waiter helper that rejects with `[ERROR] state polling exceeded its budget` when the deadline signal aborts.

- [ ] **Step 1: Write failing tests**

Test these exact behaviours:

```ts
test('routes an event to the matching waiter and keeps the stream reusable', async () => {
  const stream = createSessionEventStream<{ type: string }>();
  const first = stream.waitFor((event) => event.type === 'done');
  stream.dispatch({ type: 'ignored' });
  stream.dispatch({ type: 'done' });
  await expect(first).resolves.toEqual({ type: 'done' });

  const second = stream.waitFor((event) => event.type === 'next');
  stream.dispatch({ type: 'next' });
  await expect(second).resolves.toEqual({ type: 'next' });
});

test('rejects all pending waiters when the stream fails', async () => {
  const stream = createSessionEventStream<{ type: string }>();
  const waiting = stream.waitFor(() => true);
  stream.fail(new Error('[ERROR] SSE failed'));
  await expect(waiting).rejects.toThrow('SSE failed');
});

test('an aborted waiter does not close the shared stream', async () => {
  const stream = createSessionEventStream<{ type: string }>();
  const controller = new AbortController();
  const waiting = stream.waitFor(() => true, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow('state polling exceeded its budget');

  const next = stream.waitFor(() => true);
  stream.dispatch({ type: 'still-open' });
  await expect(next).resolves.toEqual({ type: 'still-open' });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test smoke/test/session-events.test.ts`

Expected: FAIL because the session event stream module does not exist yet.

- [ ] **Step 3: Implement the minimal reusable stream**

Maintain a private list of waiters, each containing a predicate, resolve, reject, and optional abort cleanup. `dispatch` resolves only the first matching waiter. `fail` and `close` settle every pending waiter and reject future waits. An aborted waiter is removed locally without closing the stream.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test smoke/test/session-events.test.ts`

Expected: PASS.

### Task 2: Move V1 SSE ownership to the session transport

**Files:**

- Modify: `smoke/src/host/v1-exchange.ts`
- Modify: `smoke/src/host/v1-transport.ts`
- Modify: `smoke/src/host/transport.ts`
- Test: `smoke/test/host-transport.test.ts`

**Interfaces:**

- `createLegacyHttpTransport` creates one V1 event reader per created `SmokeSession`.
- `HostTransport.prompt` and `HostTransport.waitForStateChange` consume the same reader.
- `HostTransport.removeSession` stops and awaits the reader before calling DELETE.

- [ ] **Step 1: Add failing reuse and cleanup tests**

Extend the V1 fake fetch to count `/event` requests. Run two prompts and one state wait on the same session, dispatch terminal events from one stream, and assert the count is exactly one. Add a cleanup assertion that DELETE happens only after the stream abort/cancel marker.

- [ ] **Step 2: Run focused V1 tests and verify failure**

Run: `bun test smoke/test/host-transport.test.ts`

Expected: FAIL because each current operation owns its own subscription.

- [ ] **Step 3: Implement session-owned V1 event routing**

Create a V1 session adapter that owns:

```ts
interface V1SessionEvents {
  waitFor(
    sessionId: string,
    predicate: (event: V1SseEvent) => boolean,
    signal?: AbortSignal
  ): Promise<V1SseEvent>;
  stop(): Promise<void>;
}
```

Keep child-session discovery and question answering in the single reader loop. Register the prompt terminal waiter before POSTing the message. Use the same stream for state changes. On reader EOF/error, reject all waiters with the concrete error or `[ERROR] V1 SSE завершился до terminal-события`.

- [ ] **Step 4: Run focused V1 tests and verify pass**

Run: `bun test smoke/test/host-transport.test.ts`

Expected: PASS, including existing V1 normalization and interaction tests.

### Task 3: Move V2 SSE ownership to the session client transport

**Files:**

- Modify: `smoke/src/v2-client.ts`
- Modify: `smoke/src/host/v2-transport.ts`
- Modify: `smoke/src/host/transport.ts`
- Test: `smoke/test/v2-client.test.ts`
- Test: `smoke/test/host-transport.test.ts`

**Interfaces:**

- `createV2SmokeClient` starts one event subscription for a created session.
- `prompt` registers an execution waiter before `session.prompt` and waits for V2 terminal execution events.
- Form handling, child-session discovery, and step recording remain attached to the shared listener.
- `removeSession` stops the listener and waits for its cleanup.

- [ ] **Step 1: Add failing V2 reuse and cleanup tests**

Assert that two prompts produce one `/event` subscription, that each prompt receives only its own terminal event, that forms from child sessions are answered, and that stream abort precedes session removal.

- [ ] **Step 2: Run focused V2 tests and verify failure**

Run: `bun test smoke/test/v2-client.test.ts smoke/test/host-transport.test.ts`

Expected: FAIL because the current client creates an `AbortController` and listener inside every `prompt`.

- [ ] **Step 3: Implement the shared V2 listener**

Move the reader loop and session-tree tracking into a session-owned object. Replace per-prompt `lastExecution` completion with a waiter keyed by session ID and prompt generation. Do not use a previous terminal event to complete a later prompt. Stop the listener in `removeSession` and reject all pending waiters on stream failure.

- [ ] **Step 4: Run focused V2 tests and verify pass**

Run: `bun test smoke/test/v2-client.test.ts smoke/test/host-transport.test.ts`

Expected: PASS.

### Task 4: Preserve the state-poll deadline

**Files:**

- Modify: `smoke/src/runner.ts`
- Modify: `smoke/src/host/facade.ts`
- Modify: `smoke/src/host/transport.ts`
- Test: `smoke/test/host-runner.test.ts`

**Interfaces:**

- `waitForStateChange(session, signal?: AbortSignal): Promise<void>` is optional on the host/transport contract.
- `pollOutcome` creates a controller for the remaining budget and passes its signal to the host.

- [ ] **Step 1: Add a hanging-wait test**

Create a fake host whose `waitForStateChange` never resolves. Run a step with `HOST_SMOKE_STATE_POLL_MS`/runner budget set to a short value and assert that `runScenario` returns a failure/timeout evidence instead of hanging.

- [ ] **Step 2: Run the focused runner test and verify failure**

Run: `bun test smoke/test/host-runner.test.ts`

Expected: FAIL because the current runner awaits `waitForStateChange` without a signal or local deadline race.

- [ ] **Step 3: Implement deadline-aware waiting**

At each loop calculate remaining budget. Pass an `AbortSignal` to `waitForStateChange`; if the signal aborts, perform one final durable read and return the existing poll outcome with accumulated rounds. The transport removes only its waiter, not the shared session stream.

- [ ] **Step 4: Run focused runner tests and verify pass**

Run: `bun test smoke/test/host-runner.test.ts`

Expected: PASS.

### Task 5: Final integration verification

**Files:**

- Modify: `smoke/test/host-transport.test.ts` only if integration assertions need adjustment.
- Modify: `smoke/test/v2-client.test.ts` only if integration assertions need adjustment.

- [ ] **Step 1: Run typecheck and all smoke tests**

Run: `bunx tsc --noEmit -p tsconfig.json && bun test smoke/test`

Expected: typecheck succeeds and the suite reports zero failures.

- [ ] **Step 2: Check formatting and stale timeout references**

Run: `git diff --check` and search `smoke/` for `PromptTimeoutError`, `promptTimeoutMs`, `promptWithinBudget`, `HOST_SMOKE_PROMPT_TIMEOUT_MS`, and `session.wait`.

Expected: no stale prompt-timeout references remain.

- [ ] **Step 3: Inspect the final diff**

Run: `git status --short && git diff --stat && git diff -- smoke/src smoke/test docs/superpowers/plans/2026-09-29-session-scoped-sse.md`

Expected: only session-scoped SSE, deadline handling, tests, and this plan are changed; no generated artifacts or secrets are present.
