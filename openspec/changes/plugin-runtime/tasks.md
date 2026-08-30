# Tasks: Plugin Runtime (P0 + Dashboard Skeleton)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~850-1000 (new files + tests + spec/design updates) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Phase 1-4 (core) → Phase 5 (supplementary) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes (review-workload guard — 850-1000 lines exceeds 400 limit)
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

## Phase 1: Foundation — Types & Queue

- [ ] 1.1 Create `src/app/runtime-types.ts` — `PromiseChain` interface (internal type)
- [ ] 1.2 Create `src/app/session-queue.ts` — `SessionQueue` class (per-root promise chain, enqueue/clear)

## Phase 2: Core Runtime

- [ ] 2.1 Create `src/app/runtime.ts` — `StateMachineRuntime` class + `createRuntime` factory
- [ ] 2.2 RED: write `test/app/session-queue.test.ts` — promise chaining, per-root isolation, error propagation, clear()
- [ ] 2.3 GREEN: implement SessionQueue to pass tests
- [ ] 2.4 RED: write `test/app/runtime.test.ts` — createRuntime returns Hooks, session creation, mutation lifecycle, dispose cleanup
- [ ] 2.5 GREEN: implement createRuntime + StateMachineRuntime to pass tests

## Phase 3: Dashboard & Bridge

- [ ] 3.1 Create `src/app/dashboard.ts` — `startDashboard()` Bun.serve with `/status` endpoint
- [ ] 3.2 RED: write `test/app/dashboard.test.ts` — server responds, port conflict is non-fatal
- [ ] 3.3 GREEN: implement dashboard to pass tests
- [ ] 3.4 Create `plugins/state-machine.js` — bridge file importing createRuntime, inert fallback

## Phase 4: Integration & Wiring

- [ ] 4.1 Create `src/app/index.ts` — barrel export (`createRuntime` from `./runtime.ts`)
- [ ] 4.2 Modify `src/index.ts` — add re-export of `createRuntime` from `./app/runtime.ts`
- [ ] 4.3 Verify: `bun test`, `mise run typecheck`, `mise run lint`, `mise run build`

## Phase 5: Supplementary Components (Guardrails, SDD Artifacts, Consent, Change Scope)

- [ ] 5.1 Create `src/app/guardrails.ts` — pure functions: validateUserInput, sanitizeToolOutput, extractUserText (R13)
- [ ] 5.2 Create `src/app/sdd-artifacts.ts` — computeSha256, canonicalizePlan, read/writePlanFile, parseStoryIdFromPlanPath, validateStoryId (R14)
- [ ] 5.3 Create `src/app/consent.ts` — parseConsentRequest, evidenceOf, calculatePlanEvidence, classifyConsentAnswer, verifyPlanEvidenceAtDecision (R15)
- [ ] 5.4 Create `src/app/change-scope.ts` — captureBaseline, computeChangeScope (R16)
- [ ] 5.5 RED: write `test/app/guardrails.test.ts` — block/warn/pass for all 7 guard categories, sanitizeToolOutput replaces, extractUserText
- [ ] 5.6 GREEN: implement guardrails.ts to pass tests
- [ ] 5.7 RED: write `test/app/sdd-artifacts.test.ts` — computeSha256 format, canonicalizePlan, parseStoryIdFromPlanPath
- [ ] 5.8 GREEN: implement sdd-artifacts.ts to pass tests
- [ ] 5.9 RED: write `test/app/consent.test.ts` — parseConsentRequest valid/undefined, classifyConsentAnswer grant/decline/unrecognized, evidenceOf, verifyPlanEvidenceAtDecision
- [ ] 5.10 GREEN: implement consent.ts to pass tests
- [ ] 5.11 RED: write `test/app/change-scope.test.ts` — captureBaseline, computeChangeScope (use mock git via temp dir with real git)
- [ ] 5.12 GREEN: implement change-scope.ts to pass tests
- [ ] 5.13 Verify: `bun test`, `mise run typecheck`, `mise run lint`, `mise run build`
