# Handoff — task scope and per-move invariants, 2026-09-06 (evening)

Supersedes the parts of `docs/handoff-2026-09-06.md` that concern the stage
model and the invariants gate. That file was written during the morning audit;
most of its "Open" list has since been closed, and its item 7 (a subagent's work
not reaching its parent session) is now understood precisely — see below.

## Where things stand

`task-scope-and-per-move-invariants` is **implemented and verified**, committed
as `fa78850` (34 files, +2160/−144).

| | |
| --- | --- |
| Tasks | 45/45 |
| `sdd-verify` | PASS on round 2 (round 1 was FAIL, 3 CRITICAL) |
| `bun test` | 1566 pass / 8 fail — all 8 pre-existing, see below |
| Coverage | ~92.5% against an 80% threshold |
| `tsc --noEmit`, `mise run build` | clean |
| `mise run lint` | 47 errors, **zero overlap** with the files this change touched |
| `openspec validate` | valid |

**Not archived.** `openspec list` shows `✓ Complete`, but the deltas have not
been merged, so `openspec/specs/` is still empty and the three new capabilities
are not yet part of the project's baseline spec.

**Attempt ledger.** The attempt is settled `passed`, but the objective is
`blocked: maintainer_decision` — 2589 changed lines against a declared 1500.
That only bites if a new work unit is opened against the same objective;
clearing it needs `gentle-ai sdd-attempt reset`, which is explicitly a
maintainer decision and was left to the operator.

## The 8 failing tests are not ours

Verified independently, twice, by reading the diff rather than by trusting a
report:

- **3** assert `CORE_GATES` has three gates and receive nine. The constant is
  **not in this change's diff** — `src/session/session-schema.ts` changed only
  `ActiveOperationSchema` and `MutationTaskSchema`.
- **5** in `test/e2e/shipped-profiles.test.ts`, from 38 compile errors in the
  android profile ("Unknown source stage 'qa'"). `profiles/` is not in the diff.
  This is the tail of the stage-model migration: `base.yaml` was rewritten,
  `android.yaml` was not.

Which specific test names surface the `CORE_GATES` cause shifts between runs;
the count and the root cause do not. Both groups are closed by the next change
(`docs/plans/gates-from-profile.md`), which would leave the suite fully green
for the first time.

## What was built

- `src/app/scope-match.ts` — anchored `matchesScope`, conservative
  `scopesIntersect`.
- `MutationTask` gains `readScope` / `writeScope` / `editingAgents`; loses
  `path`, `manifest`, `declaredScope`. `WorkflowSession.baselineHashes` removed.
- `ActiveOperation` gains `baseline` (the move's snapshot) and `invariants`
  (its verdict).
- `runtime.ts` — `scopeBefore`, non-overlap admission, `captureBaseline` before
  task admission, an `invariantsAfter` step, and the `run.gates.invariants`
  roll-up; plus `blocked` / `unreachable`-on-pass reporting.
- `mutation-orchestrator.ts` — a real baseline frame threaded through
  `processScopeAndInvariants`; the `{} as BaselineHashes` cast is gone.
- `test/support/task-factory.ts` and ~56 literals migrated onto it.

Design reasoning is in `docs/plans/task-scope-and-per-move-invariants.md`;
requirements are in `openspec/changes/task-scope-and-per-move-invariants/`.

## Facts that cost effort — do not re-derive

- **Hook ordering is the load-bearing constraint.** `handleWorkflowResult`
  (`runtime.ts` after-chain, step 1b) computes movement and deletes the
  operation. Anything after it — `mutationAfter` included — is a verdict about
  a move that has already left. The `invariantsAfter` step runs before it, and
  the roll-up lands where `operation`/`run`/`task` resolve, strictly before the
  `if (failed || passed)` block. Moving either compiles, passes most tests, and
  silently stops gating.
- **`minimatch`'s `matchBase` applies only to patterns containing no slash.**
  Anchoring both the path and the mask with a leading slash therefore disables
  it structurally rather than by option. `src/auth` does **not** match
  `src/auth/login.ts` — a directory without `/**` covers nothing inside it.
- **Disjoint write scopes are what make the union check exact.** Because
  admission refuses an intersecting scope, a path matches at most one active
  task's `writeScope`, so "matches some active task's scope" is equivalent to
  "matches the right one". The two requirements hold each other up; implemented
  separately, one is meaningless and the other is wrong.
- **`bash` carries no path argument**, only `workdir`. Before-the-fact
  `writeScope` enforcement is impossible for it; its writes surface in the frame
  diff afterwards. Stated as a requirement in the spec so nobody "improves" it.
- **Hook inputs carry no agent identity** — only `tool`, `sessionID`, `callID`,
  `args` (`@opencode-ai/plugin/dist/index.d.ts:235-257`). That is why
  `editingAgents` is enforced at dispatch admission and not per write.
- **The dispatch strategy is called `serial_with_overlap`**, not `overlapping`.

## Open, in the order I would take them

1. **Gates from the profile** — `docs/plans/gates-from-profile.md`. Deletes
   `CORE_GATES` and the `KNOWN_GATES` whitelist, carries the android profile
   migration, and makes the suite green. The operator's reframing is what makes
   this cheap: the session never needed a gate list, because a missing gate
   already behaves as pending.
2. **Parent/child session linkage** — slice 8 of the task-scope plan. Until it
   exists, `writeScope` / `readScope` do not reach a dispatched subagent's
   writes, because those happen in a child session that holds none of the
   parent's task operations. Both requirements now carry a "Stated limitation —
   session locality" paragraph saying so. Use `client.session.get().parentID`
   with a cache, not the host's SQLite: there are two session tables, so that
   schema has already migrated once.
3. **Archive the change** when convenient, so `openspec/specs/` stops being
   empty.
4. Whatever remains from `docs/handoff-2026-09-06.md` — items 3, 6, 20-24.

## Watch out

- **Verify agent reports overstate and understate.** One remediation report
  claimed "two concurrent task operations can never both survive a mutating tool
  call"; the method it named only ever sees the session the write happened in,
  so the real scope is same-session concurrency. Another marked task 4.5
  untested when a pre-existing test covers it. Read the code, not the summary.
- **Mutation-test every claimed regression guard.** Four of five mutations broke
  the test they should have. The fifth — making `invariantsAfter` use the newest
  frame among running operations — passed, because the inner operation is
  already deleted by the time the outer move closes. The nesting test does guard
  what matters, but it cannot distinguish "used somebody else's frame".
- **Sub-agents have run `git stash` against an explicit instruction not to
  touch git.** Nothing was lost, but check `git stash list` after a long
  delegated run.
- **`fd -H` does not override `.gitignore`.** `openspec/` is ignored here, so a
  plain `fd` search reports the directory as absent. Use `-I`.
- **The dashboard and `session-store` both read `CORE_GATES`.** Anything that
  changes gate seeding touches both.
