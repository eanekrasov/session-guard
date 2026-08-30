# Tasks: Session Store — WorkflowSession persistence

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 200–350 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

## Phase 1: Verify existing implementation against spec

- [ ] 1.1 Audit `src/session/types.ts` — types diverge from spec (e.g. `Approval` vs `ApprovalStep`, `MutationTask` vs `PlanTask`, `WorkflowSession` lacks `refs`, `currentTaskIndex`, `baselineHashes`, `changedFiles`). Apply or document each gap.
- [ ] 1.2 Audit `src/session/session-schema.ts` — verify schema exports (`ApprovalSchema`, `MutationTaskSchema`) match spec and public exports in `src/index.ts`.
- [ ] 1.3 Audit `src/session/session-store.ts` — verify `save` sets `updatedAt`, verify `delete`/`list` methods (added vs design), verify locking and atomic-write semantics.
- [ ] 1.4 Verify `src/index.ts` re-exports: `Approval` vs `Approval`, `MutationTask` vs `PlanTask`, completeness of exported symbols.

## Phase 2: Write unit & integration tests

- [ ] 2.1 Create `test/session-schema.test.ts` — Zod schema validation: valid sessions pass, invalid `Approval` missing `type`/`callId` fails, invalid `GateStatus` fails, unknown fields stripped on parse.
- [ ] 2.2 Add `passthrough` tests — load preserves unknown fields; strip removes them on save.
- [ ] 2.3 Add helper function tests — `getGate`, `setGateStatus` (with/without `resolvedAt`), `bumpRetry`, `isExhausted`, `resetRetry`, `setInvariantViolations` (evidenceId assignment).
- [ ] 2.4 Create `test/session-store.test.ts` — `WorkflowStore` with temp dir: `save`/`load` roundtrip, atomic write (temp file cleaned), `load` non-existent returns `null`, `load` corrupt JSON throws.
- [ ] 2.5 Add concurrency tests — sequential saves to same sessionId increment revision correctly; parallel saves to different IDs both complete.
- [ ] 2.6 Add directory auto-creation test — first `save` to non-existent dir succeeds.
- [ ] 2.7 Add `createSession` tests — factory returns session with all defaults per spec.

## Phase 3: Integration & wiring

- [ ] 3.1 Run full test suite: `bun test`, `mise run typecheck`, `mise run lint`, `mise run build`.
- [ ] 3.2 Verify coverage threshold (`bun test --coverage` ≥ 80%).

## Phase 4: Cleanup

- [ ] 4.1 Remove any temporary stubs or dead code paths found during audit.
