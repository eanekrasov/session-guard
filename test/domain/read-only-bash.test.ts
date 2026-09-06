import { describe, expect, it } from 'vitest';
import { isReadOnlyBashCommand } from '../../src/domain/session-queries.ts';

/**
 * `bash` is in `mutatingTools` because it usually mutates, so a read entered
 * the mutation lifecycle: `git status --short` was refused before the plan was
 * approved, and refused afterwards with "Cannot resolve a single workflow task
 * run for mutation" whenever the session had no runnable task.
 *
 * The classifier that lets a read past must fail closed: a command wrongly
 * admitted here runs with no baseline and no frame diff behind it.
 */
describe('isReadOnlyBashCommand', () => {
  it('admits the reads that were being refused', () => {
    for (const command of [
      'git status --short',
      'git status',
      'git diff HEAD',
      'git log --oneline -5',
      'git rev-parse HEAD',
      'git -C sub status',
      'ls -la src',
      'cat package.json',
      'rg -n TODO src',
      'wc -l src/index.ts',
      'git ls-files | wc -l',
      'ls && git status',
    ]) {
      expect({ command, readOnly: isReadOnlyBashCommand(command) }).toEqual({
        command,
        readOnly: true,
      });
    }
  });

  it('refuses anything that writes, or that hides what runs', () => {
    for (const command of [
      'npm run build',
      'rm -rf dist',
      'touch new.ts',
      'git commit -m x',
      'git push',
      'git checkout .',
      'git config --global user.name x',
      'git config user.name x',
      'echo hi > out.txt',
      'cat a.txt >> b.txt',
      'echo $(rm -rf /)',
      'cat x | tee y',
      'sudo ls',
      'eval "ls"',
      'source ./env.sh',
      'FOO=1 ls',
      'ls | xargs rm',
      'ls; rm x',
      '',
      '   ',
    ]) {
      expect({ command, readOnly: isReadOnlyBashCommand(command) }).toEqual({
        command,
        readOnly: false,
      });
    }
  });

  it('refuses an unknown command rather than guessing', () => {
    expect(isReadOnlyBashCommand('some-tool --probably-safe')).toBe(false);
    expect(isReadOnlyBashCommand('git some-new-subcommand')).toBe(false);
  });
});
