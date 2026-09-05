import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSha256,
  canonicalizePlan,
  validateStoryId,
  writeFile,
  readFile,
  dirnameSegment,
} from '../../src/app/sdd-artifacts.ts';

describe('computeSha256', () => {
  test('returns real SHA-256 digest with sha256: prefix (reference vector)', () => {
    expect(computeSha256('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  test('returns SHA-256 of empty string (reference vector)', () => {
    expect(computeSha256('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  test('is stable for identical input', () => {
    expect(computeSha256('abc')).toBe(computeSha256('abc'));
  });
});

describe('canonicalizePlan', () => {
  test('removes BOM', () => {
    expect(canonicalizePlan('\uFEFFa')).toBe('a');
  });

  test('normalizes CRLF to LF', () => {
    expect(canonicalizePlan('a\r\nb')).toBe('a\nb');
  });

  test('strips trailing spaces and tabs per line', () => {
    expect(canonicalizePlan('a \nb\t\nc')).toBe('a\nb\nc');
  });

  test('preserves leading tabs', () => {
    expect(canonicalizePlan('\thead\n\tbody \n')).toBe('\thead\n\tbody');
  });

  test('removes single trailing newline', () => {
    expect(canonicalizePlan('a\n')).toBe('a');
  });

  test('removes multiple trailing newlines', () => {
    expect(canonicalizePlan('a\n\n\n')).toBe('a');
  });

  test('BOM + CRLF + trailing newlines combine correctly', () => {
    // note: stray \r (not paired with \n) becomes a leading \n after CRLF→LF step
    expect(canonicalizePlan('\uFEFF\r\na\n\n')).toBe('\na');
  });

  test('leaves clean LF input without trailing newline unchanged', () => {
    const clean = '# Plan\n\n- step one\n- step two';
    expect(canonicalizePlan(clean)).toBe(clean);
  });
});

describe('validateStoryId', () => {
  test('accepts lowercase kebab slugs', () => {
    expect(validateStoryId('a')).toBe(true);
    expect(validateStoryId('story-1')).toBe(true);
    expect(validateStoryId('a'.repeat(64))).toBe(true);
  });

  test('rejects traversal, slashes, uppercase and bad first char', () => {
    expect(validateStoryId('..')).toBe(false);
    expect(validateStoryId('../etc')).toBe(false);
    expect(validateStoryId('a/b')).toBe(false);
    expect(validateStoryId('Abc')).toBe(false);
    expect(validateStoryId('-abc')).toBe(false);
    expect(validateStoryId('')).toBe(false);
    expect(validateStoryId('a'.repeat(65))).toBe(false);
  });
});

describe('writeFile / readFile', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'sm-plan-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('writes and reads back under .opencode/plan/<storyId>/plan.md', () => {
    const filePath = join(base, '.opencode/plan/story-1/plan.md');
    writeFile(filePath, '# Plan v1\n');
    expect(readFileSync(filePath, 'utf-8')).toBe('# Plan v1\n');
    expect(readFile(filePath)).toBe('# Plan v1\n');
  });

  test('readFile returns null on missing file', () => {
    expect(readFile(join(base, 'missing.md'))).toBeNull();
  });

  test('writeFile creates nested directory', () => {
    const filePath = join(base, '.opencode/plan/nested-story/plan.md');
    writeFile(filePath, 'x');
    expect(readFileSync(filePath, 'utf-8')).toBe('x');
  });

  test('writeFile writes to any arbitrary path', () => {
    const filePath = join(base, 'arbitrary/dir/plan.md');
    writeFile(filePath, 'content');
    expect(readFileSync(filePath, 'utf-8')).toBe('content');
  });
});

describe('dirnameSegment', () => {
  test('extracts slug from last directory segment', () => {
    expect(dirnameSegment('.opencode/plan/story-9/plan.md')).toBe('story-9');
    expect(dirnameSegment('/tmp/plans/story-42/v2.md')).toBe('story-42');
  });

  test('returns null when parent directory segment is invalid', () => {
    expect(dirnameSegment('src/plan.md')).toBeNull();
    expect(dirnameSegment('plan.md')).toBeNull();
    expect(dirnameSegment('.opencode/plan/../plan.md')).toBeNull();
  });
});
