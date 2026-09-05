import { describe, expect, test, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateFiles } from '../../src/app/invariants.ts';
import type { InvariantCheck } from '../../src/app/invariants.ts';

const STRING_LITERAL_RE = /"([^"]*)"/u;
export const INVARIANTS: InvariantCheck[] = [
  {
    id: 'NO_BANG_BANG',
    severity: 'error',
    appliesTo: (f) => f.endsWith('.kt'),
    check: (content) => (/!![^!]/u.test(content) ? 'Non-null assertion !! is not allowed.' : null),
  },
  {
    id: 'STRING_RES',
    severity: 'warning',
    appliesTo: (f) => f.endsWith('.kt') && /(^|[\\/])ui[\\/]/u.test(f),
    check: (content, filePath) =>
      STRING_LITERAL_RE.test(content) ? 'UI string should use string resources.' : null,
  },
  {
    id: 'LF_ONLY',
    severity: 'error',
    check: (content) => (/\r/u.test(content) ? 'CRLF detected — use LF line endings.' : null),
  },
];

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'invariants-'));
  dirs.push(directory);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(directory, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return directory;
}

describe('validateFiles', () => {
  test('rejects empty Kotlin file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'invariants-'));
    const path = join(directory, 'feature/sample/Empty.kt');
    await mkdir(join(directory, 'feature/sample'), { recursive: true });
    await writeFile(path, '');
    dirs.push(directory);

    const result = validateFiles([path], INVARIANTS, directory);
    expect(result.errors[0]?.invariant).toBe('FILE_READABLE');
    expect(result.errors[0]?.file).toBe('feature/sample/Empty.kt');
    expect(result.errors[0]?.line).toBe(1);
  });

  test('appliesTo filters invariants by file type', async () => {
    const root = await repo({
      'A.kt': 'val x = 1!!\n',
      'B.ts': 'const x = 1!!;\n',
    });

    const kt = validateFiles([join(root, 'A.kt')], INVARIANTS, root);
    expect(kt.errors.map((e) => e.invariant)).toContain('NO_BANG_BANG');

    const ts = validateFiles([join(root, 'B.ts')], INVARIANTS, root);
    expect(ts.errors.map((e) => e.invariant)).not.toContain('NO_BANG_BANG');
  });

  test('UI-only invariants skip non-UI Kotlin files', async () => {
    const root = await repo({
      'domain/Model.kt': 'val x = 1\n',
      'ui/presentation/Screen.kt': 'val label = "Hello " + name\n',
    });

    const domain = validateFiles([join(root, 'domain/Model.kt')], INVARIANTS, root);
    expect(domain.warnings.map((w) => w.invariant)).not.toContain('STRING_RES');

    const ui = validateFiles([join(root, 'ui/presentation/Screen.kt')], INVARIANTS, root);
    console.log('errors:', JSON.stringify(ui.errors));
    console.log('warnings:', JSON.stringify(ui.warnings));
    console.log('checked:', ui.checked);
    expect(ui.warnings.map((w) => w.invariant)).toContain('STRING_RES');
  });

  test('ignores unsupported file types', async () => {
    const root = await repo({ 'image.png': '\r\nbroken' });
    const result = validateFiles([join(root, 'image.png')], INVARIANTS, root);
    expect(result.checked).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test('CRLF detected in any file', async () => {
    const root = await repo({ 'test.ts': 'line1\r\nline2\n' });
    const result = validateFiles([join(root, 'test.ts')], INVARIANTS, root);
    expect(result.errors.map((e) => e.invariant)).toContain('LF_ONLY');
  });

  test('unreadable file triggers FILE_READABLE error', async () => {
    const root = await repo({ 'readable.kt': 'val x = 1\n' });
    const unreadablePath = join(root, 'unreadable.kt');
    await writeFile(unreadablePath, 'content', { mode: 0o444 });
    // Remove write permission to make it unreadable
    const { chmodSync } = await import('node:fs');
    chmodSync(unreadablePath, 0o000);

    const result = validateFiles([join(root, 'readable.kt'), unreadablePath], INVARIANTS, root);

    // Readable file should be checked
    expect(result.checked).toBe(1);
    // Unreadable file should produce FILE_READABLE error
    const fileReadable = result.errors.find((e) => e.invariant === 'FILE_READABLE');
    expect(fileReadable).toBeDefined();
    expect(fileReadable!.file).toBe('unreadable.kt');
    expect(fileReadable!.line).toBe(1);

    // Restore permissions so cleanup can delete
    chmodSync(unreadablePath, 0o644);
  });
});
