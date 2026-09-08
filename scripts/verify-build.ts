/**
 * Check that a build produced everything it claims to, and that the two
 * entrypoints are actually two.
 *
 * The bundler writes `dist/index.js` and `dist/tui.js` in separate steps, and
 * a misconfigured entry name made the second overwrite the first — a build
 * that looked successful and shipped one artifact twice.
 */
import { existsSync, readFileSync } from 'node:fs';

const required = [
  'dist/index.js',
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

if (readFileSync('dist/index.js', 'utf-8') === readFileSync('dist/tui.js', 'utf-8')) {
  console.error(
    'ERROR: dist/index.js and dist/tui.js are identical - one entrypoint overwrites the other'
  );
  process.exit(1);
}

console.error('Build verification: all outputs present, entrypoints distinct');
