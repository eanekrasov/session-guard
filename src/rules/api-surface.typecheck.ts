/**
 * Type-level API surface contract tests.
 *
 * Этот файл использует @ts-expect-error чтобы ассертить, что определённые типы
 * НЕ экспортируются. Если запрещённый тип случайно реэкспортируется,
 * @ts-expect-error станет невалидным и TypeScript компиляция упадёт.
 *
 * Этот файл проверяется `mise run build` / `tsc` но не производит runtime output.
 */

// --- mcp-tools.ts: McpStatusMap должен НЕ экспортироваться ---
// @ts-expect-error McpStatusMap is internal and should not be exported
import type { McpStatusMap } from './mcp-tools.js';

// --- runtime.ts: OpenCodeRulesRuntimeOptions должен НЕ экспортироваться ---
// @ts-expect-error OpenCodeRulesRuntimeOptions is internal and should not be exported
import type { OpenCodeRulesRuntimeOptions } from './runtime.js';

// --- session-store.ts: SessionStoreOptions должен НЕ экспортироваться ---
// @ts-expect-error SessionStoreOptions is internal and should not be exported
import type { SessionStoreOptions } from './session-store.js';

// --- matched-rules-state.ts: MatchedRulesStateStoreOptions должен НЕ экспортироваться ---
// @ts-expect-error MatchedRulesStateStoreOptions is internal and should not be exported
import type { MatchedRulesStateStoreOptions } from './matched-rules-state.js';

// --- rule-delivery.ts: delivery implementation types должны НЕ экспортироваться ---
// @ts-expect-error RuleDeliveryOptions is internal and should not be exported
import type { RuleDeliveryOptions } from './rule-delivery.js';

// Suppress unused variable warnings for the type imports above
void (0 as unknown as McpStatusMap);
void (0 as unknown as OpenCodeRulesRuntimeOptions);
void (0 as unknown as SessionStoreOptions);
void (0 as unknown as MatchedRulesStateStoreOptions);
void (0 as unknown as RuleDeliveryOptions);
