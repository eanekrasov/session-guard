import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

type PackageManifest = {
  scripts?: {
    build?: string;
  };
  exports?: {
    './tui'?: {
      import?: string;
    };
  };
};

const packagePath = path.resolve(
  import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json'
);

describe('package manifest', () => {
  it('exports the compiled TUI entrypoint', async () => {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as PackageManifest;

    expect(manifest.exports?.['./tui']?.import).toBe('./dist/tui.js');
    expect(manifest.scripts?.['build:tui']).toBe('bun scripts/build-tui.ts');
  });
});
