/**
 * Platform port for host-dependent operations of the rules engine.
 *
 * The origin lives in opencode-rules@1.0.0 (rules-v1@154d8d9), which built a
 * v1 client adapter inside the orchestrator. session-guard extracted these
 * data operations into a port so the core can run without importing any host
 * package (both `@opencode-ai/plugin` and `@opencode/plugin`).
 *
 * Hook registration and the event loop stay on `OpenCodeRulesRuntime.wire()`,
 * which consumes host-agnostic structural callbacks (no host package types).
 *
 * Implementations:
 * - v2 host: `createV2RuntimePort` (src/rules-engine/runtime/client-adapter.ts).
 * - v1 host: `src/rules-engine/runtime/v1-adapter.ts` (via V1 hooks).
 * - tests: fake port built from `src/rules-engine/test-fixtures.ts`.
 */
import type { RawHistoryResult } from '../delivery/rule-delivery-history.js';
import type { DeliveryPart } from '../delivery/rule-delivery-codec.js';

/** Durable admission write: a rule delivered for a given session. */
export interface PersistAdmission {
  (sessionID: string, part: DeliveryPart): Promise<void>;
}

/** Session history read (v2: session.context; v1: session.messages RPC). */
export interface ReadHistory {
  (sessionID: string): Promise<RawHistoryResult>;
}

/** Available tool IDs (built-in + connected MCP capabilities). */
export interface QueryAvailableToolIDs {
  (contextToolIDs?: readonly string[]): Promise<string[]>;
}

/**
 * Durable delivery sink: appends a synthetic message that persists in
 * history (v2 `session.synthetic`; v1 equivalent is the chat.message
 * hook appending a synthetic part).
 */
export interface SyntheticSink {
  (input: {
    sessionID: string;
    id?: string;
    text: string;
    description?: string;
    metadata?: Record<string, unknown>;
    resume?: boolean;
  }): Promise<unknown>;
}

/**
 * Host-dependent data operations of the rules engine, inverted as a
 * dependency. The core (OpenCodeRulesRuntime) takes this port instead of
 * building a host adapter internally.
 */
export interface RuntimePort {
  persistAdmission: PersistAdmission;
  readHistory: ReadHistory;
  queryAvailableToolIDs: QueryAvailableToolIDs;
  /** Absent on hosts without durable synthetic delivery; delivery degrades. */
  synthetic?: SyntheticSink;
}
