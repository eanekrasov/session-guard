import { describe, it, expect, beforeEach, mock } from 'bun:test';

// bun 1.3.x has no scoped per-test module mock and no `--isolate` on the pinned
// runtime, so the plain `../shared/debug.js` cache can leak in from sibling
// files running in the same worker. `mock.module` replaces the module for this
// file only, mirroring the original vitest `vi.mock(importOriginal)` intent.
const warnings: string[] = [];
mock.module('../../../src/rules-engine/shared/debug.js', () => ({
  logWarning: (context: string, error: unknown): void => {
    warnings.push(`${context}: ${String((error as Error)?.message ?? error)}`);
  },
  createDebugLog:
    () =>
    (_message: string): void =>
      undefined,
  logError: (): void => undefined,
  formatError: (error: unknown): string => (error instanceof Error ? error.message : String(error)),
}));

// A unique query string forces a fresh `rule-metadata` evaluation per test so a
// stale module (real or mocked) can't carry call records between tests.
let loadCounter = 0;
async function loadRuleMetadata() {
  loadCounter += 1;
  return import(`../../../src/rules-engine/rules/rule-metadata.js?warn=${loadCounter}`);
}

describe('fail-closed fileContains warning', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it('warns once for a declared but invalid fileContains', async () => {
    const { parseRuleMetadata } = await loadRuleMetadata();

    expect(parseRuleMetadata('---\nfileContains: ""\n---\nbody')?.fileContains).toEqual([]);
    expect(warnings.filter((w) => w.includes('fileContains'))).toHaveLength(1);
  });

  it('does not warn when the field is absent or valid', async () => {
    const { parseRuleMetadata } = await loadRuleMetadata();

    parseRuleMetadata('---\nglobs: ["**/*.ts"]\n---\nbody');
    parseRuleMetadata('---\nfileContains: "x"\n---\nbody');
    expect(warnings.filter((w) => w.includes('fileContains'))).toHaveLength(0);
  });
});
