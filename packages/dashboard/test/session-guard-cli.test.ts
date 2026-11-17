import { describe, expect, it } from 'vitest';
import { createSessionGuardCommand } from '../src/session-guard-cli.ts';

describe('dashboard session-guard CLI adapter', () => {
  it('parses JSON emitted by the CLI', async () => {
    const command = createSessionGuardCommand(['bun', '-e', 'console.log("[1,2]")']);

    await expect(command(['sessions', 'list', '--json'])).resolves.toEqual([1, 2]);
  });

  it('reports invalid JSON as a CLI contract error', async () => {
    const command = createSessionGuardCommand(['bun', '-e', 'console.log("not-json")']);

    await expect(command(['sessions', 'list', '--json'])).rejects.toThrow(
      'session-guard returned invalid JSON'
    );
  });
});
