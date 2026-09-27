# V2 parity — what is deferred and what is unverified

Condensed from `v2-v1-parity.md` (tasks `V2P-001…007`), closed and removed on 2026-09-27. The
full document survives in Engram as memory `#1637`. This note is deliberately short: the task is
done, and only the standing deferrals and one unaudited area are worth carrying forward.

## Closed

- `V2P-007`, stable V2 host smoke: a live V2 suite now exists (`smoke/`, `smoke/src/v2-client.ts`,
  `smoke/src/v2-scenarios.ts`), drives the built plugin through the generated client, answers
  consent as a host form, and asserts the state the plugin persisted — receipts in
  `odd/tasks/v2-smoke-auth-and-consent.md` (`3/3` scenarios, plus a V1 regression subset).
- Consent, degraded startup, local observability and capability status (`V2P-002…005`) are covered
  by the adapter and contract tests under `test/app/v2-*`.

## Deferred by design

- **The compaction hook is not registered.** The installed `SessionCompaction` replaces the
  summary (`result.summary`) and mutates the request's `system`/`messages`, while V1 appends an
  independent compaction output. Registering it would change host compaction semantics, so the
  capability is documented as deferred rather than approximated.
- **Prompt injection is unavailable.** V2 `session.prompt` has no V1 `noReply` equivalent.
  Approval state and transition integrity do not depend on that notification, so it is not faked.
- **Observability.** `Context` exposes no logging or reporting API; diagnostics go through the
  local console log fn and a reporter without a toast transport.

## Not audited

- **`session.generate` (generation).** Its V2 parity has not been checked by anyone, and nothing in
  the runtime uses it today.
- **Rules.** They are wired in V2 through the session `context` hook, and the request context they
  see is the host's own message list — the message-bridge fix of 2026-09-27
  (`v2MessagesWithInjected`) is what made that path safe for tool calls and their results. A
  behavioural parity audit of the rules layer on V2 has not been done.

## Why this note exists

The three V2 defects found on 2026-09-27 — `execute` returning an `Effect` where the promise tool
editor needs a promise, tools returning `output` without declaring an output schema, and the
context bridge dropping the tool history — were invisible to unit tests and to the parity claims
of that period. A "V2 matches V1 except X" statement is only worth what the live check behind it
is worth.
