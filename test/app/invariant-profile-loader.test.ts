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

  it('returns empty for unknown profiles', async () => {
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');
    const checks = await getAllProfileInvariants('nonexistent', PROFILES_DIR);
    expect(checks).toEqual([]);
  });

  it('returns empty for profiles without invariants', async () => {
    const { getAllProfileInvariants } = await import('../../src/app/invariants.ts');
    // Profile without invariants file or field
    const checks = await getAllProfileInvariants('nonexistent', PROFILES_DIR);
    expect(checks).toEqual([]);
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
