import { describe, it, expect } from 'vitest';
import path from 'node:path';

const PROFILES_DIR = path.resolve(__dirname, '../../profiles');

describe('getAllProfileInvariants', () => {
  it('loads android invariants from profile', async () => {
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');
    const checks = await getAllProfileInvariants('android', PROFILES_DIR);

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.map((c) => c.id).sort()).toEqual(
      [
        'LF_ONLY',
        'KOTLIN_STACK',
        'NO_FQN',
        'NO_BANG_BANG',
        'NO_COMMENTED_CODE',
        'NAMED_ARGS',
        'STRING_RES',
        'RAW_COLOR',
        'RAW_DP',
        'NO_BARE_DP',
        'USE_SPACER_FN',
      ].sort()
    );

    // Each check has required fields
    for (const check of checks) {
      expect(check.id).toBeTruthy();
      expect(['error', 'warning']).toContain(check.severity);
      expect(typeof check.check).toBe('function');
    }

    // Verify a check actually runs
    const lfOnly = checks.find((c) => c.id === 'LF_ONLY')!;
    expect(lfOnly.check('hello\nworld', 'test.kt', '/abs/test.kt')).toBeNull();
    expect(lfOnly.check('hello\r\nworld', 'test.kt', '/abs/test.kt')).toContain('CRLF');
  });

  it('loads harness invariants from profile', async () => {
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');
    const checks = await getAllProfileInvariants('harness', PROFILES_DIR);

    expect(checks.length).toBeGreaterThan(0);
    const ids = checks.map((c) => c.id).sort();
    expect(ids).toContain('BROKEN_IMPORT');
    expect(ids).toContain('CONSOLE_LOG');
    expect(ids).toContain('INVALID_JSON');
  });

  it('loads base invariants from profile (LF_ONLY)', async () => {
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');
    const checks = await getAllProfileInvariants('base', PROFILES_DIR);

    expect(checks.length).toBe(1);
    expect(checks[0]!.id).toBe('LF_ONLY');
  });

  it('refuses to answer for a profile it cannot load', async () => {
    // "Could not load" is not "has none". Both used to return [], and a caller
    // reading "nothing to check" as "everything passed" turned a broken
    // profile into a green invariants gate — a changed file reported clean
    // against checks that never ran. Both of the tests that stood here
    // asserted that silence, and one was named for the other case while
    // exercising this one.
    const { getAllProfileInvariants, InvariantsUnavailableError } =
      await import('../../src/app/invariants.ts');

    await expect(getAllProfileInvariants('nonexistent', PROFILES_DIR)).rejects.toBeInstanceOf(
      InvariantsUnavailableError
    );
  });

  it('returns none for a profile that declares none', async () => {
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const root = mkdtempSync(join(tmpdir(), 'inv-none-'));
    try {
      mkdirSync(join(root, 'quiet'), { recursive: true });
      writeFileSync(
        join(root, 'quiet', 'profile.json'),
        JSON.stringify({ id: 'quiet', description: 'declares no invariants', schemas: [] }),
        'utf-8'
      );

      await expect(getAllProfileInvariants('quiet', root)).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validateFilesForProfile', () => {
  it('validates files against android profile', async () => {
    const { validateFilesForProfile } = await import('../../src/app/invariants.ts');

    const result = await validateFilesForProfile(
      [path.resolve(__dirname, '../fixtures/android-sample.kt')],
      'android',
      PROFILES_DIR
    );

    expect(result.checked).toBeGreaterThan(0);
    // Just verify it runs without error and returns structured result
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('returns empty result for non-existent file', async () => {
    const { validateFilesForProfile } = await import('../../src/app/invariants.ts');

    const result = await validateFilesForProfile(
      ['/tmp/nonexistent-file-12345.kt'],
      'android',
      PROFILES_DIR
    );

    expect(result.checked).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('a delta profile inherits the invariants of the profile it extends', () => {
  const FIXTURES = path.resolve(__dirname, '../fixtures/profiles');

  it('finds invariants.ts along the extends chain, not only in its own directory', async () => {
    // `profile.json.extends` наследует СПИСОК id, а файл лежит у того предка,
    // который его объявил. Пока файл искали только у самого профиля, дельта
    // получала «declares N invariant(s) but ... cannot be loaded» на каждом
    // ходу — и вместе с броском провальный вердикт `run.checks`.
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');

    const parent = await getAllProfileInvariants('nested-rollup', FIXTURES);
    const child = await getAllProfileInvariants('inherits-invariants', FIXTURES);

    expect(parent.map((c) => c.id)).toEqual(['LF_ONLY']);
    expect(child.map((c) => c.id)).toEqual(parent.map((c) => c.id));
  });
});
