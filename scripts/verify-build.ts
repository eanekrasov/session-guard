/**
 * Check that a build produced everything it claims to, and that the
 * entrypoints are actually distinct.
 *
 * The bundler writes `dist/index.js`, `dist/cli.js` and `dist/tui.js`, and a
 * misconfigured entry name made one overwrite another — a build that looked
 * successful and shipped the same artifact twice.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const required = [
  'dist/index.js',
  'dist/cli.js',
  'dist/tui.js',
  'dist/index.d.ts',
  'dist/tui.d.ts',
  'dist/profile.schema.json',
  'dist/profile-schema.schema.json',
];

const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('Missing build outputs:', missing.join(', '));
  process.exit(1);
}

const entrypoints = ['dist/index.js', 'dist/cli.js', 'dist/tui.js'];
const distinct = new Set(entrypoints.map((file) => readFileSync(file, 'utf-8')));
if (distinct.size !== entrypoints.length) {
  console.error('ERROR: the entrypoints are not distinct - one overwrites another');
  process.exit(1);
}

// Every declaration has to come from a source. A declaration whose source is
// gone is a module that no longer exists but is still shipped and still
// typechecks as importable — the build must not carry it.
const orphans: string[] = [];
for (const entry of readdirSync('dist', { recursive: true })) {
  const rel = String(entry);
  if (!rel.endsWith('.d.ts')) continue;
  const base = `src/${rel}`;
  const sourced =
    existsSync(base) ||
    existsSync(base.replace(/\.d\.ts$/, '.ts')) ||
    existsSync(base.replace(/\.d\.ts$/, '.tsx'));
  if (!sourced) orphans.push(`dist/${rel}`);
}
if (orphans.length > 0) {
  console.error('ERROR: declarations without a source - stale build output:', orphans.join(', '));
  process.exit(1);
}

console.error(
  'Build verification: all outputs present, entrypoints distinct, no orphan declarations'
);
