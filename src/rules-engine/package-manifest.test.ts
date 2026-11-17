import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../package.json'
);

const manifest = JSON.parse(await Bun.file(packagePath).text()) as {
  version?: string;
  scripts?: Record<string, string>;
  exports?: {
    '.'?: { import?: string; types?: string };
    './tui'?: { import?: string; types?: string };
  };
};

describe('package manifest (session-guard contract)', () => {
  it('exports the compiled TUI entrypoint under dist/tui.js', () => {
    expect(manifest.exports?.['./tui']?.import).toBe('./dist/tui.js');
    expect(manifest.exports?.['./tui']?.types).toBe('./dist/tui.d.ts');
  });

  it('exports the plugin entrypoint under dist/plugin.js', () => {
    expect(manifest.exports?.['.']?.import).toBe('./dist/plugin.js');
    expect(manifest.exports?.['.']?.types).toBe('./dist/plugin.d.ts');
  });

  it('has a version and no npm scripts (build is driven by mise)', () => {
    expect(manifest.version).toBeTruthy();
    // session-guard intentionally has no `scripts` in package.json;
    // builds run via `.mise/tasks/*`.
    expect(manifest.scripts).toBeUndefined();
  });

  it('ships the compiled TUI artifact when dist/ is present', () => {
    const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
    if (!existsSync(distRoot)) {
      // dist/ is build output, not committed; skip when absent.
      return;
    }
    for (const f of ['dist/tui.js', 'dist/tui.d.ts', 'dist/plugin.js', 'dist/plugin.d.ts']) {
      expect(existsSync(path.join(distRoot, '..', f))).toBeTrue();
    }
  });
});
