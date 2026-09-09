# Tasks: Domain Layer — Pure Business Logic for State-Machine Plugin

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 600–900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (types + session-facts) → PR 2 (derive + validate) → PR 3 (engine + workflow + dispatch) |
| Delivery strategy | single-pr |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `types.ts` + `session-facts.ts` + barrel | PR 1 | `bun test domain/types.test.ts domain/session-facts.test.ts` | `SessionFacts` projection — construct `WorkflowSession`, call `toSessionFacts()`, assert fields | `git revert HEAD` — no downstream dependents |
| 2 | `derive-phase.ts` + `validate-transition.ts` | PR 2 | `bun test domain/derive-phase.test.ts domain/validate-transition.test.ts` | Guard expressions evaluated against `SessionFacts` with `evaluateGuard` | `git revert HEAD` — independent of PR 3 |
| 3 | `engine.ts` + `workflow.ts` + `dispatch.ts` + `index.ts` + `src/index.ts` patch | PR 3 | `bun test domain/engine.test.ts domain/workflow.test.ts domain/dispatch.test.ts` | Full engine flow: construct `SessionGuardEngine`, derive phase, validate transition, perform workflow ops | `git revert HEAD` — no upstream callers yet |

## Phase 1: Foundation — Types + SessionFacts Projection

- [ ] 1.1 Create `src/domain/types.ts` — export `PhaseId`, `ActionId`, `GateStatus`, `ApprovalStatus`, `TaskStatus`, `PhaseTransitionResult`, `WorkflowResult`, `EngineConfig`
- [ ] 1.2 Write RED test `src/domain/session-facts.test.ts` — cover all 10 field projections, empty approvals, no commit permit, null activeOperation, empty gates
- [ ] 1.3 Create `src/domain/session-facts.ts` — `SessionFacts` interface + `toSessionFacts(session: WorkflowSession): SessionFacts`
- [ ] 1.4 Create `src/domain/index.ts` — barrel re-export from all domain modules

## Phase 2: Derivation + Transition Validation (TDD)

- [ ] 2.1 Write RED test `src/domain/derive-phase.test.ts` — priority ordering, fallback to lowest, empty rules → `"PLANNING"`, broken expression safe-fail, gate lookups
- [ ] 2.2 Create `src/domain/derive-phase.ts` — `derivePhase(facts: SessionFacts, rules: PhaseAssignmentRule[]): PhaseId`
- [ ] 2.3 Write RED test `src/domain/validate-transition.test.ts` — legal/illegal transitions, guard pass/fail, no-session bypass, null guard
- [ ] 2.4 Create `src/domain/validate-transition.ts` — `checkTransition(from, to, transitions, session?): string | null`

## Phase 3: Engine + Workflow + Dispatch (TDD)

- [ ] 3.1 Write RED test `src/domain/engine.test.ts` — derivePhase, canPerformAction (no guards / pass / fail / short-circuit), checkTransition, custom evaluateGuardFn
- [ ] 3.2 Create `src/domain/engine.ts` — `SessionGuardEngine` class + `EvaluateGuardFn` type
- [ ] 3.3 Write RED test `src/domain/workflow.test.ts` — beginMutation (fresh/expired/throws), canCommit, approvePlan, declinePlan, markBugVerified, finishMutation, parseWorkflowResult, isExpiredMutation, hasLiveVerifier
- [ ] 3.4 Create `src/domain/workflow.ts` — 9 workflow functions with session-schema helpers
- [ ] 3.5 Write RED test `src/domain/dispatch.test.ts` — markOutputReady, clearActiveMutation, getExecutionProgress, canExitExecution
- [ ] 3.6 Create `src/domain/dispatch.ts` — 4 dispatch lifecycle functions

## Phase 4: Integration + Main Index

- [ ] 4.1 Update `src/index.ts` — add domain section re-exporting all symbols from `src/domain/index.ts`
- [ ] 4.2 Verify barrel exports — `bun test` + `mise run typecheck` + `mise run lint` + `mise run build`
