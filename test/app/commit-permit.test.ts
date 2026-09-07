import { describe, it, expect } from 'vitest';

// Pure helper behaviour lives in test/domain/session-queries.test.ts.
// This file covers the delivery-permit schema and the host argument shape
// that reaches the guard at runtime.

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

describe('host bash argument shape', () => {
  it('detects forbidden git commands in the host argument shape', async () => {
    const { extractBashCommand, hasForbiddenGitSubcommand } =
      await import('../../src/domain/session-queries.ts');
    // Regression: stringifying the whole object hid the command behind JSON
    // punctuation, so the anchored pattern never matched.
    expect(hasForbiddenGitSubcommand(extractBashCommand({ command: 'git commit -m "x"' }))).toBe(
      true
    );
    expect(hasForbiddenGitSubcommand(extractBashCommand({ command: 'git push origin main' }))).toBe(
      true
    );
    expect(hasForbiddenGitSubcommand(extractBashCommand({ command: 'git status' }))).toBe(false);
    expect(extractBashCommand({ command: 'npm test', description: 'run tests' })).toBe('npm test');
  });
});
