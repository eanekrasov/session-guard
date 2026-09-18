import { spawnSync } from 'node:child_process';

export function getCurrentHead(projectDir: string): string {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0) return (result.stdout ?? '').trim();
  } catch {
    // fall through
  }
  return 'unknown';
}
