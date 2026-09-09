# Design: Plugin Runtime (P0 + Dashboard Skeleton)

| Field | Value |
|-------|-------|
| **Change** | `plugin-runtime` |
| **Phase** | Design |
| **Precedes** | Implementation (src/app/ + tests + bridge) |
| **Depends on** | Proposal (`proposal.md`), Spec (`spec.md`) |

---

## 1. Architecture Overview

### 1.1 File Structure

```
src/app/
├── runtime.ts             # SessionGuardRuntime class + createRuntime factory
├── runtime-types.ts       # Internal runtime types (not SDK types)
├── dashboard.ts           # Minimal SSE dashboard server
├── session-queue.ts       # Per-root serial queue utility
├── guardrails.ts          # Input validation & output sanitization (R13)
├── sdd-artifacts.ts       # Plan/spec file I/O & hashing (R14)
├── consent.ts             # Consent request parsing & verification (R15)
├── change-scope.ts        # Git-based change scope tracking (R16)
└── index.ts               # Barrel export

plugins/
└── session-guard.js       # Bridge file — imports createRuntime

test/app/
├── runtime.test.ts
├── session-queue.test.ts
├── dashboard.test.ts
├── guardrails.test.ts
├── sdd-artifacts.test.ts
├── consent.test.ts
└── change-scope.test.ts
```

### 1.2 Layer Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                   Application Layer (NEW)                     │
│                                                              │
│  plugins/session-guard.js                                    │
│       │                                                      │
│       ▼                                                      │
│  src/app/runtime.ts  ── createRuntime(ctx) → Hooks           │
│       │                                                      │
│       ├── session-queue.ts: per-root serial enqueue          │
│       ├── dashboard.ts:     Bun.serve SSE status endpoint     │
│       ├── guardrails.ts:    validateUserInput + sanitize     │
│       ├── sdd-artifacts.ts: plan I/O + sha256               │
│       ├── consent.ts:       parse + verify consent requests  │
│       └── change-scope.ts:  git baseline + diff tracking     │
│       │                                                      │
│       ▼  uses                                                │
├──────────────────────────────────────────────────────────────┤
│                   Domain Layer (EXISTING)                     │
│  SessionGuardEngine, workflow functions, dispatch functions   │
├──────────────────────────────────────────────────────────────┤
│                   Data Layer (EXISTING)                       │
│  WorkflowStore, resolveConfig, evaluateGuard                  │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 Dependency Flow

```
PluginInput (SDK)
    │
    ▼
createRuntime(ctx)
    │
    ├── creates WorkflowStore(path)
    ├── creates sessionQueues Map<rootId, PromiseChain>
    ├── creates liveMutations Map<callId, rootId>
    ├── resolves profilesDir (env `HARNESS_PROFILES_DIR` or default `profiles/`)
    ├── creates engineCache Map<profileId, SessionGuardEngine>
    └── optionally starts dashboard server
    │
    ▼
Hooks {
    tool:        { workflow.create },
    chat.message,
    tool.execute.before,
    tool.execute.after,
    event,
    dispose
}
```

---

## 2. Architecture Decisions

### AD1: Factory function vs class

| Option | Description |
|--------|-------------|
| **Chosen: Factory + internal class** | `createRuntime(ctx)` creates a `SessionGuardRuntime` instance internally, returns `Hooks` that close over it |
| Rejected: Class alone | Outer factory matches parent pattern and OpenCode plugin convention |

**Rationale**: The parent uses `createRuntime(context)`, and plugin bridge expects `Plugin = (input) => Promise<Hooks>`. The internal class encapsulates mutable state (queues, maps, engine cache) cleanly.

### AD2: Engine cache — lazy per profileId

| Option | Description |
|--------|-------------|
| **Chosen: Map<profileId, SessionGuardEngine>** | Engine is created once per profileId and reused across sessions |
| Rejected: Fresh per enqueue | Parent creates fresh every enqueue for preset change detection |

**Rationale**: Plugin doesn't have the parent's preset-switching model. Profiles are static per session. Creating an engine once is cheaper.

**Config merge sequence** (cross-cutting — data-layer resolve-config + domain-layer R5.1):
On first access of a profileId, `resolveEngine()` SHALL:
1. Call `resolveConfig(profileId, profilesDir)` from the Data Layer
2. Extract `phaseAssignments`, `transitions`, `actionGuards` from all `ResolvedSchema[]`
3. Merge phaseAssignments by concat + dedup by `id`, apply full override for transitions and actionGuards
4. Construct `EngineConfig` and pass to `new SessionGuardEngine(config, evaluateGuard)`

This satisfies domain-layer AD12 (config merge is Application Layer responsibility) and data-layer resolve-config spec (resolveConfig produces ResolvedProfile with schemas).

If config hot-reload is needed later, add a `clearEngineCache()` method.

### AD3: Session serialization — per-root promise chain

| Option | Description |
|--------|-------------|
| **Chosen: Promise chain in Map<rootId, Promise<void>>** | Each root has a serial queue; concurrent operations block on previous |
| Rejected: Global queue | Per-root allows multiple projects/sessions to proceed in parallel |

**Rationale**: Same pattern as parent. Per-root serialization prevents data races per session while allowing concurrent sessions. Queue is invisible to the caller — the promise chain is entirely internal.

### AD4: Dashboard — same-process Bun.serve vs subprocess

| Option | Description |
|--------|-------------|
| **Chosen: Same-process Bun.serve** | Dashboard runs in the same Bun event loop, no IPC |
| Rejected: Bun.spawn subprocess | Parent uses subprocess for full isolation |

**Rationale**: P0 skeleton. Same-process is simpler, no IPC, no crash recovery. If dashboard becomes complex in P1, it can be split into a subprocess.

### AD5: liveMutations — Map<callId, rootSessionId>

| Option | Description |
|--------|-------------|
| **Chosen: Map<callId, rootSessionId>** | Tracks active mutation by callId for release on error |
| Rejected: store-based flag | No — store is file-backed, not a lock manager |

**Rationale**: Same as parent. CallId is unique per tool execution in a conversation. The map is cheap (in-memory only) and cleared on `dispose`.

### AD6: tool.execute.before blocking — output.args = null

| Option | Description |
|--------|-------------|
| **Chosen: Set output.args = null** | SDK uses output.args mutation to reject tool execution |
| Rejected: Throw error | Throwing in before hook may crash the runtime |

**Rationale**: The SDK `tool.execute.before` hook provides `output` as a mutable object. Setting `output.args = null` is a recognized pattern to signal "don't execute this tool" without throwing.

### AD7: Guardrails as pure functions — no class wrapper

| Option | Description |
|--------|-------------|
| **Chosen: Pure functions (validateUserInput, sanitizeToolOutput, extractUserText)** | Stateless, no class, no constructor |
| Rejected: Guardrails class | Parent uses functions — adding a class would add ceremony without benefit |

**Rationale**: All guardrails are pure input→output transformations. No mutable state, no lifecycle. Functions are directly importable by runtime.ts hooks.

**Regex scope**: All 7 guard categories (PROMPT_INJECTION, ROLE_OVERRIDE, SYSTEM_EXTRACTION, CODE_INJECTION, CONTEXT_CONFUSION, INDIRECT_INJECTION, DATA_EXFILTRATION) with the same patterns as the parent. Regex patterns are module-level constants, not configurable.

**Integration pattern**: `chat.message` hook calls `extractUserText(output.parts)` → `validateUserInput(text)` → throws on block. `tool.execute.after` calls `sanitizeToolOutput(output.output, input.tool)` → replaces output in-place on block hits.

### AD8: Consent — same-process parsing + verification, no subprocess

| Option | Description |
|--------|-------------|
| **Chosen: In-process parse + verify** | All consent logic (parsing, manifest verification, plan evidence) runs in the same process |
| Rejected: Subprocess or separate module | Parent uses in-process — consent is pure data validation, no I/O beyond `readPlanFile` from sdd-artifacts |

**Rationale**: `parseConsentRequest`, `classifyConsentAnswer`, `evidenceOf`, and `verifyPlanEvidenceAtDecision` are all synchronous, pure or I/O-isolated functions. No need for a subprocess or IPC.

**Hook integration**: Consent processing is split across `tool.execute.before` (question issuance — parse + store pending approval) and `tool.execute.after` (question answer — classify + verify + approve/decline). This mirrors the parent's two-phase consent protocol.

**Implementation note**: The plugin does not have `pendingPlanApproval`, `planRef`, or `specRef` on `WorkflowSession` yet. These fields SHALL be added to `WorkflowSession` type as part of this change: `pendingPlanApproval: { callID: string; revision: number; evidence: string; startedAt: string } | null`, `planRef: string | null`. If the user prefers not to extend `WorkflowSession` in this change, consent can be wired as `handleQuestionBefore` → `handleQuestionAfter` with approval called directly without pending state, skipping the re-verification step.

**Note on baselineHashes type**: The current `WorkflowSession.baselineHashes` type is `string[]` (list of paths). Change scope design (AD10) requires `Record<string, string | null>` (path → sha256 hash). The WorkflowSession type SHALL be updated to align with change-scope requirements during implementation.

### AD9: SDD Artifacts — port with same signatures, no plugin-specific changes

| Option | Description |
|--------|-------------|
| **Chosen: Port sdd-artifacts.ts with same API** | `computeSha256`, `canonicalizePlan`, `readPlanFile`, `writePlanFile`, `parseStoryIdFromPlanPath`, `validateStoryId` |
| Rejected: Merge into consent.ts | Kept separate — `computeSha256` is a general utility used by both change-scope (file hashing) and consent (plan evidence) |

**Rationale**: Parent keeps these separate. `sdd-artifacts.ts` provides low-level primitives (SHA-256, plan file I/O). `consent.ts` builds on them for the consent protocol. Clean separation of concerns.

**Cross-cutting**: `computeSha256` is also used by `change-scope.ts` for file content hashing. A common SHA-256 utility module avoids duplication.

### AD10: Change Scope — git-based, same-process spawnSync

| Option | Description |
|--------|-------------|
| **Chosen: child_process.spawnSync for git** | Synchronous git calls from the same process |
| Rejected: Async git via promisified spawn | Parent uses sync — faster for the fire-and-forget baseline capture in `tool.execute.before` |

**Rationale**: `captureBaseline` runs in `tool.execute.before` where latency matters (it blocks tool execution). `spawnSync` is fast for local git operations. `computeChangeScope` runs in `tool.execute.after` where latency is less critical.

**Cross-cutting**: File hashing uses `computeSha256` from `sdd-artifacts.ts` directly (consistent hash format). The `moduleRoot` parameter filters change scope to a subdirectory (e.g., `"session-guard"`), matching the parent's pattern for plugin-scoped changes.

**Session integration**: `session.baselineHashes` is populated in `tool.execute.before` and consumed in `tool.execute.after`. This field must be added to `WorkflowSession` type.

---

## 3. Interfaces (Full TypeScript)

### 3.1 `src/app/runtime-types.ts`

```typescript
export interface PromiseChain {
  previous: Promise<void>;
  add<T>(task: () => Promise<T>): Promise<T>;
}
```

### 3.2 `src/app/session-queue.ts`

```typescript
export class SessionQueue {
  private queues: Map<string, Promise<void>> = new Map();

  enqueue<T>(rootSessionId: string, action: () => Promise<T>): Promise<T>;
  clear(): void;
}
```

### 3.3 `src/app/runtime.ts`

```typescript
import type { PluginInput, Hooks, ToolContext } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { WorkflowStore, createSession } from '../session/session-store.ts';
import { SessionGuardEngine } from '../domain/engine.ts';
import type { WorkflowSession } from '../session/types.ts';

export function createRuntime(context: PluginInput): Hooks;

// Internal: SessionGuardRuntime class (not exported)
class SessionGuardRuntime {
  private store: WorkflowStore;
  private queue: SessionQueue;
  private liveMutations: Map<string, string>;
  private engineCache: Map<string, SessionGuardEngine>;
  private dashboardPort: number | null;

  constructor(context: PluginInput);

  // Internal helpers (wired into Hooks)
  private resolveEngine(profileId: string): SessionGuardEngine;
  private handleCreateWorkflow(args: { profileId: string }, toolCtx: ToolContext): Promise<string>;
  private handleChatMessage(sessionID: string): Promise<void>;
  private handleToolBefore(tool: string, sessionID: string, callID: string): Promise<void>;
  private handleToolAfter(tool: string, sessionID: string, callID: string): Promise<void>;
  private handleEvent(event: { type: string }): Promise<void>;
  private handleDispose(): Promise<void>;

  // Getter for Hooks object
  get hooks(): Hooks;
}
```

### 3.4 Dashboard skeleton

```typescript
export function startDashboard(
  runtime: SessionGuardRuntime,
): Bun.Server | null;
```

Returns `null` if `DASHBOARD_PORT` is not set or if the port is unavailable.

### 3.5 `src/app/guardrails.ts`

```typescript
export type GuardSeverity = 'block' | 'warn';

export interface GuardResult {
  passed: boolean;
  blocked: string[];
  warnings: string[];
}

export function validateUserInput(input: string): GuardResult;
export function sanitizeToolOutput(
  input: string,
  source: string
): { output: string; hits: string[] };
export function extractUserText(parts: unknown[]): string;
```

All pure functions. Module-level constants hold regex pattern arrays for 7 guard categories.

### 3.6 `src/app/sdd-artifacts.ts`

```typescript
export function computeSha256(content: string): string;
export function canonicalizePlan(content: string): string;
export function readPlanFile(storyId: string, baseDir: string): string | null;
export function writePlanFile(storyId: string, content: string, baseDir: string): void;
export function parseStoryIdFromPlanPath(filePath: string): string | null;
export function validateStoryId(slug: string): boolean;
```

### 3.7 `src/app/consent.ts`

```typescript
export interface ConsentRequest {
  schema: string;
  revision: number;
  evidence: string;
  grant: string;
  decline: string;
  manifest: ConsentManifest;
}

export interface ConsentManifest {
  schema: string;
  revision: number;
  summary: string;
  files: string[];
}

export type ConsentAnswerKind = 'grant' | 'decline' | 'unrecognized';

export interface ConsentAnswer {
  kind: ConsentAnswerKind;
  raw?: string;
}

export function parseConsentRequest(questionText: string): ConsentRequest | undefined;
export function evidenceOf(manifest: ConsentManifest): string;
export function calculatePlanEvidence(planContent: string): string;
export function classifyConsentAnswer(
  answer: string[],
  request: ConsentRequest
): ConsentAnswer;
export function verifyPlanEvidenceAtDecision(
  session: WorkflowSession
): { passed: boolean; ruleID?: string };
```

### 3.8 `src/app/change-scope.ts`

```typescript
export type BaselineHashes = Record<string, string | null>;

export function captureBaseline(
  cwd: string,
  moduleRoot?: string
): Promise<BaselineHashes>;

export function computeChangeScope(
  cwd: string,
  baseline: BaselineHashes,
  moduleRoot?: string
): Promise<string[]>;
```

---

## 4. Data Flow

### 4.1 `workflow.create` tool flow

```
User calls /workflow.create
    │
    ▼
tool.execute(args, ctx)
    │
    ├── resolve profileId:
    │   ├── args.profileId (explicit) → primary
    │   ├── process.env.HARNESS_PROFILE → fallback
    │   └── neither → throw "profileId is required"
    │
    ├── store.load(ctx.sessionID) — check existing
    │
    ├── exists? → return "already exists" error
    │
    └── not exists?
        │
        ├── resolve root session ID via ctx.client.session.get(ctx.sessionID)
        │   (walk parentID chain to find root)
        │
        ├── session = createSession(ctx.sessionID, resolvedProfileId)
        │   (session.profileId is non-empty, session.preset is @deprecated)
        │
        ├── store.save(session)
        │
        ├── queue.enqueue(rootSessionId, ...) — subsequent operations serialized per root
        │
        └── return "Created session {sessionID}"
```

**Cross-cutting**: profileId resolution satisfies data-layer resolve-config spec (`workflow.create SHALL accept profileId`, `HARNESS_PROFILE fallback`). Serial enqueue per root session ID matches session-store spec (per-key save lock).

### 4.2 `tool.execute.before` flow

```
User types a message → tool is about to execute
    │
    ▼
tool.execute.before(input, output)
    │
    ├── withSession(input.sessionID)
    │   └── session is null? → return (no-op)
    │
    ├── resolve root session ID (walk parentID chain)
    ├── queue.enqueue(rootSessionId, () => {
    │
    ├── engine = resolveEngine(session.profileId)
    │   └── resolveEngine calls resolveConfig + merge → EngineConfig
    │       (satisfies domain-layer AD12: config merge is App Layer responsibility)
    │
    ├── result = engine.canPerformAction(session, "beginMutation")
    │   └── engine internally calls toSessionFacts(session) and evaluates all actionGuards
    │
    ├── result.allowed === false?
    │   └── output.args = null (block) — per AD6
    │
    └── result.allowed === true?
        ├── beginMutation(session, input.callID)
        │   └── throws Error if active non-expired operation exists — caller must handle
        ├── store.save(session)
        ├── liveMutations.set(input.callID, rootSessionId)
        └── })
```

**Cross-cutting**: Engine receives properly merged config via resolveConfig (data-layer) satisfying R5.1 and D8. beginMutation preconditions per domain-layer R6.1: guards already checked before calling. Live mutation tracking via liveMutations map (AD5).

### 4.3 `tool.execute.after` flow

```
Tool finishes execution
    │
    ▼
tool.execute.after(input, output)
    │
    ├── liveMutations.delete(input.callID)
    │
    ├── withSession(input.sessionID)
    │   └── session is null? → return
    │
    ├── resolve root session ID → enqueue
    ├── queue.enqueue(rootSessionId, () => {
    │
    ├── finishMutation(session, passed, changedFiles)
    │   └── passed/output result derived from tool output (output.passed, output.changedFiles)
    │
    ├── store.save(session)
    └── })
```

**Cross-cutting**: finishMutation per domain-layer R6.6 — sets activeOperation to null, updates gates, bumps retry on failure. Session saved via queue.enqueue to maintain per-root serialization (session-store spec: per-key lock).

### 4.4 `dispose` flow

```
Plugin is unloaded
    │
    ▼
dispose()
    │
    ├── dashboard?.stop()
    ├── liveMutations.clear()
    ├── queue.clear()
    ├── engineCache.clear()
    └── return
```

### 4.5 Consent flow (two-phase: issuance + decision)

```
User asks agent → agent calls question tool
    │
    ▼
tool.execute.before (handleQuestionBefore)
    │
    ├── parseConsentRequest(questionText)
    │   └── no consent tag? → return (no-op)
    │
    ├── readPlanFile(storyId, baseDir)
    │   └── plan file missing? → throw
    │
    ├── evidenceOf(manifest) === consentRequest.evidence?
    │   └── mismatch? → throw (tampering)
    │
    ├── calculatePlanEvidence(planContent) → store in session.pendingPlanApproval
    │
    └── Question shown to user
            │
            ▼
    tool.execute.after (handleQuestionAfter)
            │
            ├── classifyConsentAnswer(answer, request)
            │
            ├── verifyPlanEvidenceAtDecision(session)
            │   └── re-reads plan file, re-hashes, compares → fail? → warn, no-op
            │
            ├── grant? → approvePlan(session, digest, callID)
            ├── decline? → declinePlan(session, digest, callID, declineLabel)
            └── unrecognized? → no-op
```

### 4.6 Guardrails pipeline

```
User message → chat.message hook
    │
    ├── extractUserText(output.parts) — extracts user text + file attachments
    ├── validateUserInput(text) — tests 7 guard categories
    ├── blocked? → throw Error (message rejected)
    └── warnings? → log (message proceeds)

Tool output → tool.execute.after hook
    │
    ├── sanitizeToolOutput(output.output, input.tool)
    ├── block-level hits? → replace matched text with [BLOCKED:guard.id]
    ├── warn-level hits? → log only
    └── output.output = sanitized output
```

---

## 5. Testing Strategy

### 5.1 Unit tests

| Test file | Coverage |
|-----------|----------|
| `test/app/session-queue.test.ts` | Promise chaining, per-root isolation, error propagation |
| `test/app/runtime.test.ts` | createRuntime returns Hooks, tool registration, session creation, mutation lifecycle |
| `test/app/guardrails.test.ts` | validateUserInput (block/warn/pass), sanitizeToolOutput, extractUserText |
| `test/app/sdd-artifacts.test.ts` | computeSha256, canonicalizePlan, readPlanFile, parseStoryIdFromPlanPath |
| `test/app/consent.test.ts` | parseConsentRequest, classifyConsentAnswer, evidenceOf, verifyPlanEvidenceAtDecision |
| `test/app/change-scope.test.ts` | captureBaseline, computeChangeScope (with mock git) |

### 5.2 Key scenarios

| Test | Expectation |
|------|-------------|
| `createRuntime` returns valid Hooks with all 6 hooks | Each hook is a function |
| `workflow.create` creates and saves session | Session file exists after call |
| `workflow.create` rejects duplicate | Error message returned |
| `withSession` returns null for missing session | Action not called |
| `tool.execute.before` blocks when guard fails | output.args set to null |
| `tool.execute.before` starts mutation when allowed | session.activeOperation is set |
| `tool.execute.after` finishes mutation | session.activeOperation is null |
| `dispose` cleans up all maps | All maps empty after call |
| Dashboard starts when port is configured | Server responds on /status |
| `resolveConfig` called on first engine access | Engine has correct phaseAssignments/transitions/actionGuards |
| `HARNESS_PROFILE` env provides fallback profileId | workflow.create without explicit profileId succeeds |
| Event hook clears mutation on error | liveMutations entry removed, session cleared |
| Guardrails block prompt injection | validateUserInput returns blocked=["PROMPT_INJECTION"] |
| Guardrails sanitize exfiltration in tool output | sanitizeToolOutput replaces credential text with [BLOCKED:...] |
| extractUserText extracts text from file attachments | File text content returned |
| parseConsentRequest parses valid consent tag | Returns ConsentRequest with matching fields |
| parseConsentRequest returns undefined for plain question | No consent request detected |
| classifyConsentAnswer recognizes grant | { kind: "grant" } returned |
| verifyPlanEvidenceAtDecision detects tampered plan | { passed: false } with ruleID |
| computeSha256 produces correct format | Result matches ^sha256:[0-9a-f]{64}$ |
| canonicalizePlan normalizes CRLF | \r\n converted to \n |

---

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| SDK Hooks types change between versions | Low | Pin @opencode-ai/plugin version, lock types in spec |
| enqueue deadlock on async error | Low | Promise chain always resolves (catch + release) |
| Dashboard port conflict | Low | Bun.serve fallback to port 0, logged warning |
| Session save race condition | Low | Per-root serial queue prevents concurrent writes |
| Guardrails false positive blocks | Medium | warn-level guards log only; block-level rules are high-confidence patterns |
| Consent plan file missing between phases | Low | verifyPlanEvidenceAtDecision catches this and rejects gracefully |
| Git not available for change-scope | Low | captureBaseline/computeChangeScope throw with clear error |

---

## 7. Cross-Change Dependencies

### 7.1 Dependency Inventory

Every import from another change's module:

| Source module | Source change | Imported symbol | Used by | Type |
|--------------|---------------|-----------------|---------|------|
| `../session/session-store.ts` | session-store | `WorkflowStore` | runtime.ts | class |
| `../session/session-store.ts` | session-store | `createSession` | runtime.ts | function |
| `../session/types.ts` | session-store | `WorkflowSession` | runtime.ts, session-queue.ts | interface |
| `../domain/engine.ts` | domain-layer | `SessionGuardEngine` | runtime.ts | class |
| `../domain/engine.ts` | domain-layer | `EvaluateGuardFn` | runtime.ts | type |
| `../domain/types.ts` | domain-layer | `EngineConfig` | runtime.ts | interface |
| `../domain/workflow.ts` (dynamic) | domain-layer | `beginMutation` | runtime.ts | function |
| `../domain/workflow.ts` (dynamic) | domain-layer | `finishMutation` | runtime.ts | function |
| `../domain/dispatch.ts` (dynamic) | domain-layer | `clearActiveMutation` | runtime.ts | function |
| `../public-api.ts` | data-layer | `resolveConfig` | runtime.ts | function |
| `../guard-evaluator.ts` | cross-cutting | `GuardEvaluator` | runtime.ts | class |
| `../schema/types.ts` | data-layer | `ResolvedSchema` | runtime.ts | type |

### 7.2 Dependency graph visualization

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────────┐
│ data-layer│────▶│ session-store│────▶│ domain-layer  │────▶│ plugin-runtime │
│           │     │              │     │              │     │                │
│ resolveConfig│  │ WorkflowStore│     │ SessionGuard  │     │ createRuntime  │
│ GuardEvaluator│  │ createSession│     │  Engine       │     │ Hooks wiring   │
│ ResolvedSchema│ │ WorkflowSession│   │ beginMutation │     │ Dashboard      │
└──────────┘     └──────────────┘     │ finishMutation │     └────────────────┘
                                      │ clearActiveOp │
                                      └──────────────┘
```

### 7.3 Verification constraints

- plugin-runtime cannot be verified in isolation — it depends on types and functions from all three lower changes
- verify MUST be run after all dependency changes have been applied and verified
- Unit tests for plugin-runtime SHOULD mock dependency functions/types where possible
- Integration test SHALL use real (unmocked) dependency implementations

### 7.4 Rollback order

When rolling back plugin-runtime, dependency changes MUST NOT be rolled back unless they also need rollback. Dependency changes are backward-compatible — they provide public API that plugin-runtime uses, so removing plugin-runtime does not break other consumers.
