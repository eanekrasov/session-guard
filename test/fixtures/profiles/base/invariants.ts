/**
 * The invariants this fixture's `profile.json` declares.
 *
 * The declaration was there and this file was not. `getAllProfileInvariants`
 * used to answer `[]` both for "declares none" and for "cannot be loaded", so
 * every check over this fixture reported a clean file against checks that
 * never ran. Failing closed on an unloadable module surfaced it.
 *
 * The two rules are deliberately trivial: what the fixture is for is metadata
 * resolution and inheritance, and five tests assert these ids by name.
 */
import type { InvariantCheck } from '../../../../profiles/invariants.types.ts';

export const INVARIANTS: InvariantCheck[] = [
  {
    id: 'no-console',
    severity: 'error',
    appliesTo: (filePath) => filePath.endsWith('.ts'),
    check: (content) =>
      /\bconsole\.log\s*\(/.test(content) ? '[no-console] console.log is not allowed' : null,
  },
  {
    id: 'strict-null',
    severity: 'warning',
    appliesTo: (filePath) => filePath.endsWith('.ts'),
    check: (content) =>
      /:\s*any\b/.test(content) ? '[strict-null] an explicit `any` weakens the check' : null,
  },
];
