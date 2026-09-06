import { describe, expect, it } from 'vitest';
import { mergeTransitions } from '../../src/schema/schema-loader.ts';
import type { TransitionDef } from '../../src/schema/types.ts';

const edge = (from: string, to: string, guard: string): TransitionDef => ({ from, to, guard });

describe('mergeTransitions', () => {
  it('keeps several edges between the same pair', () => {
    // A pair carries more than one edge, told apart by their guards — one for
    // the gates that passed, one for the gates that failed. Keying a single
    // edge per pair collapsed them into the last one declared, and the
    // alternative was gone before the engine ever saw it.
    const base = [edge('a', 'b', 'passed'), edge('a', 'b', 'failed'), edge('b', 'c', 'true')];

    const merged = mergeTransitions(base, [edge('b', 'c', 'stricter')]);

    expect(merged).toEqual([
      edge('a', 'b', 'passed'),
      edge('a', 'b', 'failed'),
      edge('b', 'c', 'stricter'),
    ]);
  });

  it('replaces a redeclared pair as a whole', () => {
    // Replacing one edge of a pair and keeping the others would leave a
    // parent's guard standing behind a child that meant to supersede it.
    const base = [edge('a', 'b', 'passed'), edge('a', 'b', 'failed')];

    const merged = mergeTransitions(base, [edge('a', 'b', 'only this one now')]);

    expect(merged).toEqual([edge('a', 'b', 'only this one now')]);
  });

  it("appends a pair the parent does not declare, after the parent's own", () => {
    const merged = mergeTransitions([edge('a', 'b', 'x')], [edge('b', 'c', 'y')]);

    expect(merged).toEqual([edge('a', 'b', 'x'), edge('b', 'c', 'y')]);
  });

  it('returns the other side untouched when one is absent', () => {
    const only = [edge('a', 'b', 'x'), edge('a', 'b', 'y')];
    expect(mergeTransitions(undefined, only)).toEqual(only);
    expect(mergeTransitions(only, undefined)).toEqual(only);
  });
});
