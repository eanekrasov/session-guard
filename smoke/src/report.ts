import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Записать отчёт прогона туда, где его ждут.
 *
 * `docs/plans` перечислен в `.gitignore` и в свежем checkout-е отсутствует, а
 * `writeFile` родительский каталог не создаёт. Прогон падал на `ENOENT` уже
 * после сценариев: отчёт терялся, и `verify-loop` с честным PASS заканчивался
 * ненулевым кодом выхода, потому что запись отчёта — часть раннера.
 */
export async function writeSmokeReport(reportPath: string, report: string): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, 'utf-8');
}
