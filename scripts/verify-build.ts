/**
 * Check that a build produced everything it claims to, and that the
 * entrypoints are actually distinct.
 *
 * The bundler writes `dist/index.js`, `dist/cli.js` and `dist/tui.js`, and a
 * misconfigured entry name made one overwrite another — a build that looked
 * successful and shipped the same artifact twice.
 */
import { existsSync, readFileSync } from 'node:fs';

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

console.error('Build verification: all outputs present, entrypoints distinct');
