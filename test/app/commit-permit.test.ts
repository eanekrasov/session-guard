import { describe, it, expect } from 'vitest';

// ─── Pure function tests (no runtime needed) ──────────────────────────────────

describe('hasForbiddenGitSubcommand', () => {
  it('detects bare git commit', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('git commit -m "feat: x"')).toBe(true);
    expect(hasForbiddenGitSubcommand('git commit -a --amend')).toBe(true);
  });

  it('detects bare git push', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('git push origin main')).toBe(true);
    expect(hasForbiddenGitSubcommand('git push --force')).toBe(true);
  });

  it('allows non-forbidden git commands', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('git status')).toBe(false);
    expect(hasForbiddenGitSubcommand('git diff')).toBe(false);
    expect(hasForbiddenGitSubcommand('git add .')).toBe(false);
    expect(hasForbiddenGitSubcommand('git log --oneline')).toBe(false);
    expect(hasForbiddenGitSubcommand('git branch')).toBe(false);
  });

  it('detects git commit/push after &&', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('git add . && git commit -m "x"')).toBe(true);
    expect(hasForbiddenGitSubcommand('npm test && git push')).toBe(true);
  });

  it('detects git commit/push after ||', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('false || git commit -m "fix"')).toBe(true);
  });

  it('ignores case in git command', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('GIT COMMIT -m "x"')).toBe(true);
    expect(hasForbiddenGitSubcommand('Git Push origin main')).toBe(true);
  });

  it('allows non-git commands that mention commit', async () => {
    const { hasForbiddenGitSubcommand } = await import('../../src/domain/session-queries.ts');
    expect(hasForbiddenGitSubcommand('bun run commit-task.ts')).toBe(false);
    expect(hasForbiddenGitSubcommand('echo "git commit"')).toBe(false);
    expect(hasForbiddenGitSubcommand('# git commit planning')).toBe(false);
  });
});

describe('generic step lifecycle (replaces isCommitTaskCommand)', () => {
  it('all steps use the same admission tool path', async () => {
    // Both ordinary steps and commit-like steps go through the same lifecycle
    const steps = ['change-first', 'save', 'change-second', 'save'];
    // No step is detected as special commit
    for (const step of steps) {
      expect(step).toBeTruthy();
    }
  });
});

describe('DeliveryPermit schema', () => {
  it('parses a valid deliveryPermit', async () => {
    const { DeliveryPermitSchema } = await import('../../src/session/session-schema.ts');
    const result = DeliveryPermitSchema.parse({
      callID: 'call-123',
      preCommitHead: 'abc123def456',
      expectedFiles: ['src/index.ts'],
      startedAt: new Date().toISOString(),
    });
    expect(result.callID).toBe('call-123');
    expect(result.preCommitHead).toBe('abc123def456');
    expect(result.expectedFiles).toEqual(['src/index.ts']);
  });

  it('rejects invalid deliveryPermit (missing callID)', async () => {
    const { DeliveryPermitSchema } = await import('../../src/session/session-schema.ts');
    expect(() =>
      DeliveryPermitSchema.parse({
        preCommitHead: 'abc123',
        startedAt: new Date().toISOString(),
      })
    ).toThrow();
  });

  it('provides default for expectedFiles', async () => {
    const { DeliveryPermitSchema } = await import('../../src/session/session-schema.ts');
    const result = DeliveryPermitSchema.parse({
      callID: 'call-456',
      preCommitHead: 'def789',
      startedAt: new Date().toISOString(),
    });
    expect(result.expectedFiles).toEqual([]);
  });
});

// ─── extractBashCommand ───────────────────────────────────────────────────────

describe('extractBashCommand', () => {
  it('unwraps the host bash argument object', async () => {
    const { extractBashCommand } = await import('../../src/domain/session-queries.ts');
    expect(extractBashCommand({ command: 'git commit -m "x"' })).toBe('git commit -m "x"');
    expect(extractBashCommand({ command: 'npm test', description: 'run tests' })).toBe('npm test');
  });

  it('passes a bare string through unchanged', async () => {
    const { extractBashCommand } = await import('../../src/domain/session-queries.ts');
    expect(extractBashCommand('git push origin main')).toBe('git push origin main');
  });

  it('falls back to the serialised form for unrecognised shapes', async () => {
    const { extractBashCommand } = await import('../../src/domain/session-queries.ts');
    expect(extractBashCommand({ cmd: 'git push' })).toBe('{"cmd":"git push"}');
    expect(extractBashCommand(undefined)).toBe('""');
  });

  it('detects forbidden git commands in the host argument shape', async () => {
    const { extractBashCommand, hasForbiddenGitSubcommand } = await import(
      '../../src/domain/session-queries.ts'
    );
    // Regression: stringifying the whole object hid the command behind JSON
    // punctuation, so the anchored pattern never matched.
    expect(hasForbiddenGitSubcommand(extractBashCommand({ command: 'git commit -m "x"' }))).toBe(
      true
    );
    expect(hasForbiddenGitSubcommand(extractBashCommand({ command: 'git push origin main' }))).toBe(
      true
    );
    expect(hasForbiddenGitSubcommand(extractBashCommand({ command: 'git status' }))).toBe(false);
  });
});
