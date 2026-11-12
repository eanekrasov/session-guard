import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { createDebugLog } from '../shared/debug.js';

const debugLog = createDebugLog();
const GIT_TIMEOUT_MS = 5000;
type GitExec = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

export async function getGitBranch(
  projectDir: string,
  execFn: GitExec = (file, args, options, callback) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, callback);
  }
): Promise<string | null> {
  try {
    const branch = await new Promise<string | null>((resolve) => {
      const opts: ExecFileOptionsWithStringEncoding = {
        cwd: projectDir,
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      };
      execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const trimmed = String(stdout).trim();
        if (!trimmed || trimmed === 'HEAD') {
          resolve(null);
          return;
        }
        resolve(trimmed);
      });
    });
    return branch;
  } catch (err) {
    debugLog(`Failed to get git branch: ${err}`);
    return null;
  }
}
