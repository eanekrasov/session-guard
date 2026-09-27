import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSmokeReport } from '../src/report.ts';

/**
 * `docs/plans` исключён из Git и отсутствует в свежей рабочей копии. Раньше запись отчёта
 * о прогоне туда вызывала `ENOENT` после каждого сценария, из-за чего отчёт терялся,
 * а успешно завершившийся сценарий превращался в неудачную задачу.
 */

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'host-smoke-report-'));
  cleanupDirs.push(directory);
  return directory;
}

describe('writeSmokeReport', () => {
  it('creates the missing parent directory instead of failing with ENOENT', async () => {
    const directory = await projectDirectory();
    const reportPath = join(directory, 'docs', 'plans', 'host-smoke.md');

    expect(existsSync(join(directory, 'docs'))).toBe(false);

    await writeSmokeReport(reportPath, '# Host smoke\n');

    expect(existsSync(reportPath)).toBe(true);
    expect(await readFile(reportPath, 'utf-8')).toBe('# Host smoke\n');
  });

  it('replaces the report of the previous run', async () => {
    const directory = await projectDirectory();
    const reportPath = join(directory, 'docs', 'plans', 'host-smoke.md');

    await writeSmokeReport(reportPath, '# first run\n');
    await writeSmokeReport(reportPath, '# second run\n');

    expect(await readFile(reportPath, 'utf-8')).toBe('# second run\n');
  });
});
