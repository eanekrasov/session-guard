import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { HostKind, ParityReportEntry, ScenarioResult } from './host/types.ts';

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

export function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
}

export interface HostBinding {
  kind: HostKind;
  binary: string;
}

export interface ParityMatrixRowView {
  scenarioId: string;
  requiredOn: Record<HostKind, boolean>;
  reason: string;
}

/** Which command produced the report; the parity table exists only for a parity run. */
export type ReportMode = 'parity' | 'single-host';

export interface ParityReportInput {
  mode: ReportMode;
  model: string;
  plugin: string;
  hosts: HostBinding[];
  /** One row per scenario that actually ran. */
  results: ScenarioResult[];
  /** One row per selected canonical scenario, whatever happened to it. */
  entries: ParityReportEntry[];
  matrix: ParityMatrixRowView[];
  exitCode: number;
  durationMs: number;
}

const HOST_LABELS: Record<HostKind, string> = { v1: 'V1', v2: 'V2' };

const MODE_NOTES: Record<ReportMode, string> = {
  parity: 'Один и тот же canonical registry запущен через оба host kinds.',
  'single-host': 'Запущен один host kind; паритет V1/V2 требует запуска обоих.',
};

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function resultCell(result: ScenarioResult | undefined): string {
  if (result === undefined) return '—';
  if (result.status === 'pass') return '**ПРОЙДЕНО**';
  if (result.status === 'fail') return '**ОШИБКА**';
  return `**ЗАБЛОКИРОВАНО** (${result.blockedReason})`;
}

function parityCell(entry: ParityReportEntry): string {
  if (entry.parity === 'not-run') return `not-run (${entry.notRunReason ?? 'причина не указана'})`;
  return entry.parity;
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

/**
 * Отчёт прогона: одна схема для V1 и V2.
 *
 * Результаты обеих сторон лежат в одной таблице, поэтому расхождение видно в одной
 * строке. `not-run` — это незавершённая миграция или недоступная живая среда, всегда с
 * причиной и без `ScenarioResult`: он никогда не маскируется под `fail` или `pass`.
 */
export function renderParityReport(input: ParityReportInput): string {
  const hosts = input.hosts.map((host) => `${HOST_LABELS[host.kind]} (\`${host.binary}\`)`);
  const lines = [
    '# Проверка хоста — session-guard с реальным opencode',
    '',
    `| Модель | \`${input.model}\` |`,
    '|---|---|',
    `| Режим | ${input.mode} — ${MODE_NOTES[input.mode]} |`,
    `| Хосты | ${hosts.join(', ')} |`,
    `| Плагин | \`${input.plugin.split('/').at(-1) ?? input.plugin}\` |`,
    `| Длительность | ${formatDuration(input.durationMs)} |`,
    `| Код выхода | ${input.exitCode} |`,
    '',
    '## Результаты',
    '',
    ...table(
      ['Сценарий', 'Хост', 'Результат', 'Попытки', 'Длительность', 'Доказательство'],
      input.results.map((result) => [
        `\`${result.id}\``,
        HOST_LABELS[result.hostKind],
        resultCell(result),
        String(result.attempts),
        formatDuration(result.durationMs),
        cell(result.evidence).slice(0, 300),
      ])
    ),
    '',
  ];

  if (input.entries.length > 0) {
    lines.push(
      '## Паритет V1/V2',
      '',
      'Одна строка на каждый выбранный canonical-сценарий. `—` означает, что эта сторона не',
      'дала результата; причина названа в колонке Parity и в доказательстве.',
      '',
      ...table(
        ['Сценарий', 'V1', 'V2', 'Parity', 'Доказательство'],
        input.entries.map((entry) => [
          `\`${entry.scenarioId}\``,
          resultCell(entry.v1),
          resultCell(entry.v2),
          parityCell(entry),
          cell(entry.evidence).slice(0, 300),
        ])
      ),
      ''
    );
  }

  lines.push(
    '## Матрица паритета (из canonical registry)',
    '',
    ...table(
      ['Сценарий', 'Обязателен на V1', 'Обязателен на V2', 'Причина'],
      input.matrix.map((row) => [
        `\`${row.scenarioId}\``,
        row.requiredOn.v1 ? 'да' : 'нет',
        row.requiredOn.v2 ? 'да' : 'нет',
        cell(row.reason),
      ])
    ),
    '',
    'Коды выхода: `0` — все обязательные runnable-сценарии прошли и не осталось незавершённого;',
    '`1` — есть `fail`; `2` — ни один сценарий не запустился и причина не названа, или фатальная',
    'ошибка адаптера/запуска; `3` — есть `blocked` без `fail`; `4` — осталась только незавершённая',
    'миграция; `5` — живая среда недоступна для migrated-сценария. Приоритет: fail/fatal, blocked,',
    'недоступная среда, незавершённая миграция.',
    ''
  );
  return lines.join('\n');
}
