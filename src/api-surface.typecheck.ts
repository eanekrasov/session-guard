/**
 * Type-level API surface contract tests. Each import must fail because of
 * its @ts-expect-error; accidentally exporting the type makes the error
 * directive invalid and fails compilation. Checked by tsc; no runtime
 * output.
 *
 * Adapted from opencode-rules@1.0.0 (rules-v1@154d8d9): same contract —
 * internal option types must not leak into the public surface.
 */

// @ts-expect-error McpStatusMap is internal and should not be exported
import type { McpStatusMap } from './detection/mcp-tools.js';

// @ts-expect-error OpenCodeRulesRuntimeOptions is internal and should not be exported
import type { OpenCodeRulesRuntimeOptions } from './runtime/orchestrator.js';

// @ts-expect-error SessionStoreOptions is internal and should not be exported
import type { SessionStoreOptions } from './session/session-store.js';

// @ts-expect-error MatchedRulesStateStoreOptions is internal and should not be exported
import type { MatchedRulesStateStoreOptions } from './session/matched-rules-state.js';

// @ts-expect-error RuleDeliveryOptions is internal and should not be exported
import type { RuleDeliveryOptions } from './delivery/rule-delivery.js';

void (0 as unknown as McpStatusMap);
void (0 as unknown as OpenCodeRulesRuntimeOptions);
void (0 as unknown as SessionStoreOptions);
void (0 as unknown as MatchedRulesStateStoreOptions);
void (0 as unknown as RuleDeliveryOptions);
