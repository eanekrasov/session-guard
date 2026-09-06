import { minimatch } from 'minimatch';

/**
 * Anchor a path or glob mask with a leading slash so every pattern contains a
 * slash. This disables minimatch's `matchBase` structurally rather than by
 * option, and makes `src/auth/**` and `/src/auth/**` the same mask.
 */
function anchor(p: string): string {
  return '/' + p.replace(/^\/+/, '');
}

/**
 * Whether `path` matches any glob in `globs`. Both sides are anchored (D7)
 * before comparison. An absent or empty `globs` matches nothing.
 */
export function matchesScope(path: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  const anchoredPath = anchor(path);
  return globs.some((glob) => minimatch(anchoredPath, anchor(glob)));
}

const GLOB_METACHARS = /[*?[\]{}]/;

/** Split an anchored glob mask into its `/`-delimited segments. */
function segmentsOf(mask: string): string[] {
  return anchor(mask)
    .split('/')
    .filter((segment) => segment.length > 0);
}

/**
 * Conservative intersection test between two anchored glob masks (D4).
 *
 * The error direction is fixed: false "intersecting" over false "disjoint",
 * because a wrong admission silently cross-attributes two diffs. Walks
 * segments pairwise:
 *
 * 1. both segments literal and different -> disjoint
 * 2. either segment holds a glob metacharacter -> assume intersecting
 * 3. `**` in either -> intersecting
 * 4. one list exhausted while the other has more segments -> disjoint
 * 5. otherwise -> intersecting
 */
function masksIntersect(a: string, b: string): boolean {
  const segmentsA = segmentsOf(a);
  const segmentsB = segmentsOf(b);
  const length = Math.min(segmentsA.length, segmentsB.length);

  for (let i = 0; i < length; i++) {
    const segA = segmentsA[i]!;
    const segB = segmentsB[i]!;

    if (segA === '**' || segB === '**') return true;
    if (GLOB_METACHARS.test(segA) || GLOB_METACHARS.test(segB)) return true;
    if (segA !== segB) return false;
  }

  if (segmentsA.length !== segmentsB.length) return false;
  return true;
}

/**
 * Whether any mask in `a` intersects any mask in `b`. An absent or empty
 * scope list intersects nothing — a read-only task never blocks admission.
 */
export function scopesIntersect(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return false;
  return a.some((maskA) => b.some((maskB) => masksIntersect(maskA, maskB)));
}
