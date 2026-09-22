import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createDebugLog, logWarningAlways } from './debug.js';

const debugLog = createDebugLog();

export interface MatchedRulesState {
  sessionID: string;
  matchedRulePaths: string[];
  evaluatedAt: number;
}

interface MatchedRulesStateStoreOptions {
  stateDir?: string;
}

// Strict pattern for safe sessionID: alphanumeric, underscore, hyphen only
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidSessionID(sessionID: string): boolean {
  return SAFE_SESSION_ID_PATTERN.test(sessionID);
}

function resolveStateDir(): string {
  return path.join(os.homedir(), '.opencode', 'state', 'opencode-rules');
}

function buildStateFilePath(sessionID: string, stateDir: string): string {
  if (!isValidSessionID(sessionID)) {
    throw new Error(`Invalid sessionID: ${sessionID}`);
  }
  return path.join(stateDir, `${sessionID}.json`);
}

/**
 * Какие правила сматчились в сессии, запомненные для сайдбара.
 *
 * **Запись — best-effort и так сказано здесь, а не в типе возврата.**
 * Файловая ошибка предупреждается и отбрасывается: вызывающий получает
 * resolved promise и не может узнать, что запись не случилась. Это намеренно
 * — оба писателя — хук хендлеры без чего ретраить и кого уведомить,
 * а читатель уже трактует отсутствующее состояние как нормальное, потому что
 * сессия, которая ещё не оценивалась, его не имеет.
 *
 * То же касается конкурентности. `writeQueues` сериализует записи в пределах
 * одного экземпляра, и это всё что он делает: два экземпляра, делящие
 * state-директорию, оба читают старое состояние, оба добавляют свои пути и оба
 * переименовывают свой файл поверх, так что один мерж теряется каждый раз.
 * Атомарный rename защищает файл от разрыва, но никогда не read-modify-write
 * вокруг него. Продакшн строит один стор на рантайм, так что сюда ничего
 * не доходит сегодня — `WorkflowStore` это где живёт кросс-процессный лок,
 * потому что потеря одного из его записей теряет workflow state.
 *
 * Из всего этого следует: это подсказка, не источник истины. Ничто,
 * что что-то решает, не может зависеть от этого. Если когда-нибудь нужно
 * будет знать, выжило ли состояние, этот класс должен начать репортить
 * фейл и держать лок через процессы, и оба вызывающих должны вырасти
 * куда-то репортить.
 */
export class MatchedRulesStateStore {
  private readonly stateDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(opts: MatchedRulesStateStoreOptions = {}) {
    this.stateDir = opts.stateDir ?? resolveStateDir();
  }

  /**
   * Replace семантика для полных durable turns.
   *
   * Best-effort: файловая ошибка резолвится как успех (см. класс
   * doc). Только невалидный sessionID реджектит.
   *
   * @throws {Error} Если sessionID не проходит валидацию.
   */
  write(sessionID: string, matchedPaths: readonly string[]): Promise<void> {
    this.assertValidSessionID(sessionID);
    return this.enqueue(sessionID, async () => ({
      sessionID,
      matchedRulePaths: [...matchedPaths],
      evaluatedAt: Date.now(),
    }));
  }

  /**
   * Union семантика для mid-session admissions: атомарно мержит новые
   * пути с персистнутым состоянием так что существующие матченные правила
   * выживают.
   *
   * Best-effort: файловая ошибка резолвится как успех (см. класс
   * doc). Только невалидный sessionID реджектит.
   *
   * @throws {Error} Если sessionID не проходит валидацию.
   */
  merge(sessionID: string, matchedPaths: readonly string[]): Promise<void> {
    this.assertValidSessionID(sessionID);
    return this.enqueue(sessionID, async () => {
      const existing = await readMatchedRulesState(sessionID, {
        stateDir: this.stateDir,
      });
      return {
        sessionID,
        matchedRulePaths: [...new Set([...(existing?.matchedRulePaths ?? []), ...matchedPaths])],
        evaluatedAt: Date.now(),
      };
    });
  }

  private assertValidSessionID(sessionID: string): void {
    if (!isValidSessionID(sessionID)) {
      throw new Error(`Invalid sessionID: ${sessionID}`);
    }
  }

  /** Сериализовать per-session записи; каждая операция вычисляет своё состояние
   * внутри очереди так что конкурентные мержи не могут переплести
   * read-modify-write. */
  private enqueue(sessionID: string, operation: () => Promise<MatchedRulesState>): Promise<void> {
    const previous = this.writeQueues.get(sessionID) ?? Promise.resolve();
    const current = previous
      .then(async () => this.doAtomicWrite(sessionID, await operation()))
      .finally(() => {
        if (this.writeQueues.get(sessionID) === current) {
          this.writeQueues.delete(sessionID);
        }
      });
    this.writeQueues.set(sessionID, current);
    return current;
  }

  private async doAtomicWrite(sessionID: string, state: MatchedRulesState): Promise<void> {
    const finalPath = buildStateFilePath(sessionID, this.stateDir);
    const tempPath = path.join(
      this.stateDir,
      `.${sessionID}-${crypto.randomBytes(8).toString('hex')}.tmp`
    );

    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      const content = JSON.stringify(state);
      await fs.writeFile(tempPath, content, 'utf-8');
      await fs.rename(tempPath, finalPath);
    } catch (error) {
      // Warned unconditionally: this write is not observable by its caller,
      // so a debug-gated message would make a lost write leave no trace at all
      // unless somebody had already suspected one.
      logWarningAlways(`Failed to write matched rules state for session ${sessionID}`, error);

      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/** Прочитать матченные правила состояние. @throws {Error} Если sessionID не проходит валидацию. */
export async function readMatchedRulesState(
  sessionID: string,
  options: { stateDir?: string } = {}
): Promise<MatchedRulesState | null> {
  const filePath = buildStateFilePath(sessionID, options.stateDir ?? resolveStateDir());

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);

    if (!isValidMatchedRulesState(parsed)) {
      debugLog(`Invalid matched rules state format for session ${sessionID}`);
      return null;
    }

    return parsed;
  } catch (error) {
    debugLog(`Failed to read matched rules state for session ${sessionID}: ${error}`);
    return null;
  }
}

function isValidMatchedRulesState(value: unknown): value is MatchedRulesState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj['sessionID'] !== 'string') {
    return false;
  }

  if (typeof obj['evaluatedAt'] !== 'number') {
    return false;
  }

  if (!Array.isArray(obj['matchedRulePaths'])) {
    return false;
  }

  for (const item of obj['matchedRulePaths']) {
    if (typeof item !== 'string') {
      return false;
    }
  }

  return true;
}
