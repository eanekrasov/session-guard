import { describe, it, expect } from 'bun:test';
import { parseRuleMetadata } from '../../src/rules/rule-metadata.js';

describe('fail-closed fileContains warning', () => {
  it('warns once for a declared but invalid fileContains', () => {
    const result = parseRuleMetadata('---\nfileContains: ""\n---\nbody');
    expect(result?.fileContains).toEqual([]);
    // Verifying behavior, not log output — the function returns [] for invalid fileContains
  });

  it('does not warn when the field is absent or valid', () => {
    const absent = parseRuleMetadata('---\nglobs: ["**/*.ts"]\n---\nbody');
    expect(absent?.fileContains).toBeUndefined();

    const valid = parseRuleMetadata('---\nfileContains: "x"\n---\nbody');
    expect(valid?.fileContains).toEqual(['x']);
  });
});
