import { describe, it, expect } from 'vitest';

import { getGitBranch } from './git-branch.js';

type GitExec = NonNullable<Parameters<typeof getGitBranch>[1]>;
type GitExecArguments = Parameters<GitExec>;

function mockExecFile(
  stdout: string,
  error: Error | null = null,
  inspect?: (
    file: GitExecArguments[0],
    args: GitExecArguments[1],
    opts: GitExecArguments[2]
  ) => void,
  stderr = ''
): GitExec {
  return (file, args, opts, callback) => {
    inspect?.(file, args, opts);
    callback(error, stdout, stderr);
  };
}

describe('getGitBranch', () => {
  it('calls execFile with git binary and correct argv', async () => {
    let calls = 0;
    const execFile = mockExecFile('main\n', null, (file, args) => {
      calls++;
      expect(file).toBe('git');
      expect(args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    });

    await getGitBranch('/project', execFile);
    expect(calls).toBe(1);
  });

  it('passes cwd, timeout, and killSignal in options', async () => {
    const execFile = mockExecFile('main\n', null, (_file, _args, opts) => {
      expect(opts.cwd).toBe('/my/project/dir');
      expect(opts.timeout).toBe(5000);
      expect(opts.killSignal).toBe('SIGTERM');
    });

    await getGitBranch('/my/project/dir', execFile);
  });

  it('returns current branch name when git succeeds', async () => {
    expect(await getGitBranch('/project', mockExecFile('main\n'))).toBe('main');
  });

  it('returns null if not a git repository', async () => {
    expect(
      await getGitBranch('/not-a-repo', mockExecFile('', new Error('fatal: not a git repository')))
    ).toBeNull();
  });

  it('returns null if command fails', async () => {
    expect(
      await getGitBranch('/project', mockExecFile('', new Error('Command failed')))
    ).toBeNull();
  });

  it('returns null for detached HEAD state', async () => {
    expect(await getGitBranch('/project', mockExecFile('HEAD\n'))).toBeNull();
  });

  it('trims stdout whitespace', async () => {
    expect(await getGitBranch('/project', mockExecFile('  feature/test  \n'))).toBe('feature/test');
  });

  it('tolerates stderr noise when stdout is valid', async () => {
    expect(
      await getGitBranch('/project', mockExecFile('develop\n', null, undefined, 'warning'))
    ).toBe('develop');
  });

  it('returns null when stdout is empty', async () => {
    expect(await getGitBranch('/project', mockExecFile(''))).toBeNull();
  });

  it('returns null when stdout is only whitespace', async () => {
    expect(await getGitBranch('/project', mockExecFile('   \n\t  '))).toBeNull();
  });

  it('never throws on unexpected errors', async () => {
    const execFile: GitExec = () => {
      throw new Error('Unexpected sync error');
    };

    expect(await getGitBranch('/project', execFile)).toBeNull();
  });
});
