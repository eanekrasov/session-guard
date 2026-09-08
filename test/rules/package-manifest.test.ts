import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

type PackageManifest = {
  scripts?: Record<string, string>;
  exports?: {
    './tui'?: {
      import?: string;
    };
  };
};

const repoRoot = path.resolve(
  import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const packagePath = path.join(repoRoot, 'package.json');
const buildTaskPath = path.join(repoRoot, '.mise', 'tasks', 'build');

describe('package manifest', () => {
  it('exports the compiled TUI entrypoint', async () => {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as PackageManifest;

    expect(manifest.exports?.['./tui']?.import).toBe('./dist/tui.js');
  });

  it('carries no scripts — tasks live in .mise/tasks', async () => {
    // `.mise/tasks/pkgjsonlint` states the rule and CI runs the tasks, so a
    // script here is a second entry point that nothing keeps in step with the
    // first.
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as PackageManifest;

    expect(manifest.scripts).toBeUndefined();
  });

  it('builds the TUI entrypoint the manifest exports', async () => {
    // The export above is a promise that `dist/tui.js` exists. Something has
    // to produce it, and since the scripts block went away that something is
    // the build task.
    const buildTask = await readFile(buildTaskPath, 'utf8');

    expect(buildTask).toContain('bun scripts/build-tui.ts');
    expect(buildTask).toContain('dist/tui.js');
  });
});
