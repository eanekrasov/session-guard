import { mkdir, readFile, rename, writeFile, readdir, unlink, open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowSessionSchema } from './session-schema.ts';
import { archiveDirOf, sessionFileName, sessionIdFromFileName } from './session-files.ts';

import type { WorkflowSession } from './session-schema.ts';
import type { LogFn } from '../app/logger.ts';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Новая сессия, припаркованная в стадии, с которой начинается её workflow.
 *
 * `initialStage` раньше был литералом `'planning'` — первой стадией базового
 * профиля, записанной в ядро. Схема, объявляющая `start → done`, создавала
 * сессию в стадии, которой у неё нет: нет исходящего ребра, нет допуска,
 * и ничего не говорилось об ошибке. Продакшн передаёт скомпилированную
 * начальную стадию (`SessionGuardEngine.getInitialStage`); дефолт — удобство
 * для фикстур, чья первая стадия `planning`, а вызывающий код, полагающийся
 * на него для чего-либо ещё, получает тот же дефект обратно.
 */
export function createSession(
  sessionId: string,
  profileId: string,
  schemaId: string,
  initialStage: string = ''
): WorkflowSession {
  return {
    schemaVersion: 1,
    sessionId,
    profileId,
    schemaId,
    revision: 0,
    title: '',
    stageGateResults: [],
    approvals: [],
    refs: {},
    tasks: {},
    activeOperations: {},
    verdictProvenance: {},
    activeTaskContexts: [],
    loopRuns: {},
    deliveryPermit: null,
    deliveryReceipt: null,
    retryBudgets: {},
    pendingDecisions: [],
    updatedAt: new Date().toISOString(),
    verifications: [],
    changedFiles: [],
    currentStage: initialStage,
    invariantViolations: [],
    consentedCallIDs: [],
    processedResultCallIDs: [],
  };
}

/** Как долго запись ждёт лок другого процесса перед сдачей. */
const LOCK_TIMEOUT_MS = 5_000;

/** Лок старше этого принадлежал процессу, умершему с локом в руках. */
const LOCK_STALE_MS = 30_000;

/** Сохранение, построенное на ревизии, которой в файле уже нет. */
export class WorkflowSessionConflictError extends Error {
  readonly name = 'WorkflowSessionConflictError';
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(message: string, expectedRevision: number, actualRevision: number) {
    super(message);
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

// ─── WorkflowStore ────────────────────────────────────────────────────────────

export class WorkflowStore {
  private directory: string;
  private locks = new Map<string, Promise<void>>();
  private log: LogFn;

  /**
   * Кэш: sessionID → parentID (или сам sessionID для корня).
   *
   * Заполняется только `SessionQueue.resolveRoot` из того, что ответил хост.
   * `save()` раньше засеял его из `session.testStatus['parentID']` до того,
   * как сессия вообще была провалидирована — поле, в которое никогда никто не
   * писал, и которое с тех пор убрали, поэтому запись всегда была
   * `sessionId → sessionId`. Это единственный ответ,
   * который никогда нельзя угадывать: он помечает сессию как свой корень и
   * останавливает опрос хоста, именно так дочерняя сессия вылезала бы из
   * workflow родителя. Цепочка родителей принадлежит хосту; сюда попадает
   * только его ответ.
   */
  readonly onSave = new Set<() => void>();

  constructor(basePath: string, log?: LogFn) {
    this.directory = basePath;
    this.log = log ?? (() => Promise.resolve());
  }

  async save(session: WorkflowSession): Promise<void> {
    // Snapshot pre-mutation values so we can roll back if validation fails
    const revisionBefore = session.revision;
    const updatedAtBefore = session.updatedAt;

    session.revision++;
    session.updatedAt = new Date().toISOString();

    let clean: WorkflowSession;
    try {
      clean = WorkflowSessionSchema.parse(session);
    } catch (err) {
      // Roll back the mutations we just made so callers can retry
      session.revision = revisionBefore;
      session.updatedAt = updatedAtBefore;
      const message = `[ERROR] Failed to validate session: ${err instanceof Error ? err.message : String(err)}`;
      void this.log('error', message, { sessionId: session.sessionId });
      throw new Error(message);
    }

    const json = JSON.stringify(clean, null, 2) + '\n';
    const targetPath = this.sessionPath(session.sessionId);
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    void this.log('debug', 'Сохранение сессии', {
      sessionId: session.sessionId,
      dir: this.directory,
    });

    const key = session.sessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const chain = prev
      .then(() => mkdir(this.directory, { recursive: true }))
      // Проверка ревизии и запись — один шаг, или они ничего не значат.
      // Цепочка в процессе выше сериализует этот экземпляр; она ничего не
      // говорит о втором WorkflowStore, втором экземпляре плагина или втором
      // хосте. Два из них прочитали одну и ту же ревизию, оба прошли проверку
      // и оба записали — оба сообщили об успехе, и одно обновление пропало.
      .then(() =>
        this.withFileLock(session.sessionId, async () => {
          await this.assertNotStale(session.sessionId, revisionBefore);
          await writeFile(tmpPath, json, { mode: 0o600 });
          await rename(tmpPath, targetPath);
        })
      )
      .catch((err) => {
        // Откатить in-memory бамп, чтобы вызывающий код мог перезагрузить
        // и повторить на чистом объекте, точно так же, как при ошибке валидации выше.
        session.revision = revisionBefore;
        session.updatedAt = updatedAtBefore;
        if (!(err instanceof WorkflowSessionConflictError)) {
          void this.log('error', `Ошибка I/O при сохранении сессии ${session.sessionId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      })
      .finally(() => {
        // Всегда освобождать лок — даже если I/O упал. Без .finally()
        // неудачный writeFile/rename оставил бы отклонённый промис в
        // `this.locks`, из-за чего каждый последующий `save()` для этого ключа
        // бы вешал или падал навсегда.
        if (this.locks.get(key) === chain) {
          this.locks.delete(key);
        }
      });

    this.locks.set(key, chain);
    await chain;

    for (const cb of this.onSave) cb();
    void this.log('info', `Session saved: ${session.sessionId}`, {
      revision: clean.revision,
      tasksTotal: Object.values(clean.tasks).flat().length,
      tasksCompleted: Object.values(clean.tasks)
        .flat()
        .filter((task) => task.status === 'completed').length,
    });
  }

  /**
   * Удержать кросс-процессный лок сессии на время одной записи.
   *
   * `open(path, 'wx')` падает, когда файл существует — это единственный
   * compare-and-swap, который даёт файловая система. Лок старше
   * `LOCK_STALE_MS` принадлежал процессу, умершему с локом в руках, и его
   * ломают, а не ждут — запись, которая не может завершиться, не должна
   * останавливать все последующие навсегда.
   */
  private async withFileLock<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    const lockPath = `${this.sessionPath(sessionId)}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        await (await open(lockPath, 'wx')).close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

        const age = await stat(lockPath).then(
          (info) => Date.now() - info.mtimeMs,
          () => null // он исчез под нами; пробуем захватить
        );
        if (age !== null && age > LOCK_STALE_MS) {
          void this.log('warn', `Breaking a stale session lock`, { sessionId, ageMs: age });
          await unlink(lockPath).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `[ERROR] Timed out waiting for the session lock on ${sessionId} after ${LOCK_TIMEOUT_MS}ms`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 8));
      }
    }

    try {
      return await write();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }

  /**
   * Отклонить запись, построенную на ревизии, которую кто-то уже заменил.
   *
   * `revision` инкрементировался при каждом сохранении и сравнивался с ничем,
   * поэтому поле записывало, сколько раз этот процесс писал, и ничего не
   * говорило о том, всё ещё валидна ли запись. Два писателя — второй экземпляр
   * плагина, второй хост — каждый загружал ревизию N и каждый писал N+1, и
   * более поздний беззвучно стирал работу более раннего.
   *
   * Запускается внутри цепочки локов на сессию, поэтому атомарно и против
   * собственных записей этого процесса.
   */
  private async assertNotStale(sessionId: string, revisionBefore: number): Promise<void> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return;

    let onDisk: number | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
      const value = (parsed as { revision?: unknown }).revision;
      if (typeof value === 'number') onDisk = value;
    } catch {
      // Нечитаемый или повреждённый файл не несет ревизии для конфликта.
      // Перезапись — это ремонт, а не гонка.
      return;
    }

    if (onDisk === undefined || onDisk === revisionBefore) return;

    const message =
      `[ERROR] Session ${sessionId} changed underneath this write: ` +
      `loaded revision ${revisionBefore}, on disk ${onDisk}. Reload and retry.`;
    void this.log('error', message, {
      sessionId,
      expectedRevision: revisionBefore,
      actualRevision: onDisk,
    });
    throw new WorkflowSessionConflictError(message, revisionBefore, onDisk);
  }

  async load(sessionId: string): Promise<WorkflowSession | null> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return null;

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `[ERROR] Failed to read session file: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('[ERROR] Corrupt session file: invalid JSON');
    }

    const result = WorkflowSessionSchema.passthrough().safeParse(parsed);
    if (!result.success) {
      void this.log('warn', `Session schema mismatch (not our format): ${sessionId}`, {
        issues: result.error.issues.map((i) => i.message),
      });
      return null;
    }
    const data = result.data;
    void this.log('info', `Session loaded: ${sessionId}`, {
      revision: data.revision,
      profileId: data.profileId,
      directory: this.directory,
      filePath,
      storeDir: process.env.SESSION_GUARD_STORE_DIR ?? '(not set)',
    });
    return data;
  }

  /**
   * Удалить сессию, упорядоченно относительно каждой записи в неё.
   *
   * Голое `unlink` не задело ни in-process цепочку, ни файловый лок, поэтому
   * `save()`, уже державший свою полезную нагрузку, завершался после и
   * переименовывал сессию обратно на место — удаление сообщало об успехе, а
   * файл был на месте. Совместное использование обоих локов делает две операции
   * упорядоченными, а не гонкой: та, что встала в очередь последней, и решает.
   *
   * Предыдущая запись, упавшая с ошибкой, не останавливает удаление, поэтому
   * это цепляется на `prev.catch()`, где `save()` цепляется на `prev` — сессию,
   * в которую никто не мог писать, всё равно должно быть можно удалить.
   */
  async delete(sessionId: string): Promise<void> {
    const filePath = this.sessionPath(sessionId);

    const key = sessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let removed = false;
    const chain: Promise<void> = prev
      .catch(() => {})
      .then(() =>
        this.withFileLock(sessionId, async () => {
          if (!existsSync(filePath)) return;
          await unlink(filePath);
          removed = true;
        })
      )
      .finally(() => {
        if (this.locks.get(key) === chain) this.locks.delete(key);
      });

    this.locks.set(key, chain);
    await chain;
    if (removed) void this.log('info', `Session deleted: ${sessionId}`);
  }

  /**
   * Убрать законченную сессию из рантайма, сохранив её целиком.
   *
   * Терминальная стадия — конец workflow, и дальше сессия не должна
   * управлять ничем: ни допуском, ни переходами, ни ходом мутации. «Сессии
   * нет» в этом проекте выражается ровно одним способом — файла нет там, где
   * его ищут (`load`). Заводить второй способ не-существования значило бы
   * учить каждое место различать два вида отсутствия.
   *
   * Поэтому перенос, а не удаление: расписка о доставке, гейты, вердикты и
   * одобрения — это и есть продукт работы, и стирать его в момент, когда он
   * окончательно сложился, незачем. Архив читают те, кому нужен итог: TUI,
   * dashboard, host-smoke.
   *
   * Порядок блокировок тот же, что у `delete`: цепочка в процессе плюс файловый
   * лок, иначе `save()`, уже державший свою полезную нагрузку, переименует
   * сессию обратно в рантайм после переноса.
   */
  async archive(sessionId: string): Promise<string | null> {
    const filePath = this.sessionPath(sessionId);
    const targetPath = path.join(archiveDirOf(this.directory), sessionFileName(sessionId));

    const key = sessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let moved = false;
    const chain: Promise<void> = prev
      .catch(() => {})
      .then(() =>
        this.withFileLock(sessionId, async () => {
          if (!existsSync(filePath)) return;
          await mkdir(path.dirname(targetPath), { recursive: true });
          await rename(filePath, targetPath);
          moved = true;
        })
      )
      .finally(() => {
        if (this.locks.get(key) === chain) this.locks.delete(key);
      });

    this.locks.set(key, chain);
    await chain;
    if (moved) void this.log('info', `Session archived: ${sessionId}`, { path: targetPath });
    return moved ? targetPath : null;
  }

  /**
   * Прочитать законченную сессию из архива. `load` её уже не видит — в том и
   * смысл, — а показать итог кому-то надо.
   */
  async loadArchived(sessionId: string): Promise<WorkflowSession | null> {
    const filePath = path.join(archiveDirOf(this.directory), sessionFileName(sessionId));
    if (!existsSync(filePath)) return null;
    try {
      return WorkflowSessionSchema.parse(JSON.parse(await readFile(filePath, 'utf-8')));
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        void this.log('info', 'Listed sessions: 0 found (directory does not exist)');
        return [];
      }
      void this.log('error', 'list: readdir failed', {
        error: nodeErr.message ?? String(err),
      });
      throw err;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // Имя, которое не декодируется, не было записано этим стором. Раньше
      // оно выбрасывало `URIError` из цикла, и один случайный файл делал
      // невидимыми все сессии.
      const decoded = sessionIdFromFileName(entry.name);
      if (decoded === null) continue;
      ids.push(decoded);
    }
    void this.log('info', `Найдено сессий: ${ids.length}`);
    return ids.sort();
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.directory, sessionFileName(sessionId));
  }
}
