import { describe, it, expect } from 'vitest';
import { matchesScope, scopesIntersect } from '../../src/app/scope-match.ts';

describe('matchesScope', () => {
  it('matches a recursive glob against nested paths', () => {
    expect(matchesScope('src/auth/login.ts', ['src/auth/**'])).toBe(true);
    expect(matchesScope('src/auth/deep/a.ts', ['src/auth/**'])).toBe(true);
  });

  it('does not match a recursive glob against sibling or unrelated paths', () => {
    expect(matchesScope('src/auth.ts', ['src/auth/**'])).toBe(false);
    expect(matchesScope('test/auth/a.test.ts', ['src/auth/**'])).toBe(false);
  });

  it('does not match anything inside a bare directory mask', () => {
    expect(matchesScope('src/auth/login.ts', ['src/auth'])).toBe(false);
  });

  it('anchors matching, disabling basename-anywhere matching', () => {
    expect(matchesScope('x.ts', ['*.ts'])).toBe(true);
    expect(matchesScope('deep/nested/x.ts', ['*.ts'])).toBe(false);
  });

  it('refuses everything when globs are absent or empty', () => {
    expect(matchesScope('src/a.ts', undefined)).toBe(false);
    expect(matchesScope('src/a.ts', [])).toBe(false);
  });
});

describe('scopesIntersect', () => {
  it('reports disjoint literal-prefix masks as non-intersecting', () => {
    expect(scopesIntersect(['src/auth/**'], ['src/billing/**'])).toBe(false);
  });

  it('reports overlapping masks as intersecting', () => {
    expect(scopesIntersect(['src/auth/**'], ['src/auth/login.ts'])).toBe(true);
  });

  it('treats an absent or empty scope as intersecting nothing', () => {
    expect(scopesIntersect(undefined, ['src/auth/**'])).toBe(false);
    expect(scopesIntersect([], ['src/auth/**'])).toBe(false);
  });

  it('conservatively treats admissible-but-ambiguous wildcard pairs as intersecting (D4)', () => {
    expect(scopesIntersect(['src/*.ts'], ['src/*.tsx'])).toBe(true);
    expect(scopesIntersect(['src/**/*.test.ts'], ['src/**/*.impl.ts'])).toBe(true);
  });
});
