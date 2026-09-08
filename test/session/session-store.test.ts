import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';

import path from 'path';
import { randomUUID } from 'crypto';

// RED: Reference production code that does NOT exist yet
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';

const TEST_DIR = path.join('/tmp', 'session-store-test-' + randomUUID());

describe('WorkflowStore', () => {
  let store: WorkflowStore;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    store = new WorkflowStore(TEST_DIR);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  /**
   * Конец workflow убирает сессию из рантайма, но не из мира.
   *
   * «Сессии нет» этот проект выражает ровно одним способом — `load` не находит
   * файла. Второй способ не-существования заводить нельзя: каждому месту
   * пришлось бы различать два вида отсутствия. Отсюда перенос, а не удаление:
   * расписка, гейты и вердикты — продукт работы, и стирать его в момент, когда
   * он сложился, незачем.
   */
  describe('archive', () => {
    it('убирает сессию из рантайма и сохраняет её целиком', async () => {
      const session = createSession('finished', 'android', 'state-machine');
      session.deliveryReceipt = 'abc123';
      await store.save(session);

      const target = await store.archive('finished');

      expect(target).not.toBeNull();
      expect(await store.load('finished')).toBeNull();
      const archived = await store.loadArchived('finished');
      expect(archived?.sessionId).toBe('finished');
      expect(archived?.deliveryReceipt).toBe('abc123');
    });

    it('не показывает архив в списке рантайма', async () => {
      await store.save(createSession('a', 'android', 'state-machine'));
      await store.save(createSession('b', 'android', 'state-machine'));
      await store.archive('a');

      expect(await store.list()).toEqual(['b']);
    });

    it('архивировать нечего — это не ошибка', async () => {
      expect(await store.archive('never-existed')).toBeNull();
      expect(await store.loadArchived('never-existed')).toBeNull();
    });
  });

  describe('save and load', () => {
    it('roundtrip preserves all fields', async () => {
      const session = createSession('test-session-1', 'android', 'state-machine');
      session.title = 'Test Session';

      await store.save(session);

      const loaded = await store.load('test-session-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe('test-session-1');
      expect(loaded!.profileId).toBe('android');
      expect(loaded!.title).toBe('Test Session');
      expect(loaded!.gates).toEqual([]);
    });

    it('increments revision on save', async () => {
      const session = createSession('test-revision', 'android', 'state-machine');
      expect(session.revision).toBe(0);

      await store.save(session);
      expect(session.revision).toBe(1);
    });

    it('increments revision on subsequent saves', async () => {
      const session = createSession('test-revision-2', 'android', 'state-machine');

      await store.save(session);
      await store.save(session);
      await store.save(session);

      expect(session.revision).toBe(3);
    });

    it('increments revision on second save', async () => {
      const session = createSession('test-second', 'android', 'state-machine');
      await store.save(session);
      const rev1 = session.revision;

      await store.save(session);

      expect(session.revision).toBe(rev1 + 1);
    });
  });

  describe('atomic write', () => {
    it('writes atomically — no .tmp files remain after save', async () => {
      const session = createSession('test-atomic', 'android', 'state-machine');

      await store.save(session);

      const entries = await readdir(TEST_DIR);
      const tmpFiles = entries.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('uses encodeURIComponent for session filenames', async () => {
      const session = createSession('root/sub/session', 'android', 'state-machine');

      await store.save(session);

      const expectedName = encodeURIComponent('root/sub/session') + '.json';
      const filePath = path.join(TEST_DIR, expectedName);
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe('root/sub/session');
    });

    it('encodes session IDs with spaces', async () => {
      const session = createSession('my session', 'android', 'state-machine');

      await store.save(session);

      const expectedName = 'my%20session.json';
      const filePath = path.join(TEST_DIR, expectedName);
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe('my session');
    });
  });

  describe('load edge cases', () => {
    it('returns null for missing session', async () => {
      const result = await store.load('nonexistent');

      expect(result).toBeNull();
    });

    it('throws descriptive error for corrupt JSON', async () => {
      const filePath = path.join(TEST_DIR, encodeURIComponent('corrupt-session') + '.json');
      await writeFile(filePath, '{ invalid json }', 'utf-8');

      await expect(store.load('corrupt-session')).rejects.toThrow(/Failed to read|Corrupt/);
    });

    it('load preserves unknown fields via passthrough', async () => {
      const data: Record<string, unknown> = {
        sessionId: 'passthrough-test',
        profileId: 'android',
        schemaId: 'state-machine',
        futureField: 'should survive',
      };
      const filePath = path.join(TEST_DIR, 'passthrough-test.json');
      await writeFile(filePath, JSON.stringify(data), 'utf-8');

      const loaded = await store.load('passthrough-test');

      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe('passthrough-test');
      expect((loaded as unknown as Record<string, unknown>).futureField).toBe('should survive');
    });
  });

  describe('delete and list', () => {
    it('deletes a session file', async () => {
      const session = createSession('delete-session', 'android', 'state-machine');
      await store.save(session);

      await store.delete('delete-session');

      const loaded = await store.load('delete-session');
      expect(loaded).toBeNull();
    });

    it('does not throw when deleting non-existent session', async () => {
      await expect(store.delete('nonexistent')).resolves.toBeUndefined();
    });

    it('lists session IDs', async () => {
      await store.save(createSession('list-session-1', 'android', 'state-machine'));
      await store.save(createSession('list-session-2', 'ios', 'state-machine'));

      const ids = await store.list();

      expect(ids).toContain('list-session-1');
      expect(ids).toContain('list-session-2');
      expect(ids).toHaveLength(2);
    });

    it('stays deleted when a save was already in flight', async () => {
      const session = createSession('racing-delete', 'android', 'state-machine');
      // A payload big enough that the write is still in progress when the
      // delete is issued.
      session.changedFiles = Array.from({ length: 20_000 }, (_, i) => `file-${i}.ts`);
      await store.save(session);

      const saving = store.save(session);
      await store.delete('racing-delete');
      await saving;

      // The delete used to run outside both locks: the save's rename landed
      // afterwards and put the file back.
      expect(await store.load('racing-delete')).toBeNull();
    });

    it('skips a file whose name is not a decodable session id', async () => {
      await store.save(createSession('list-valid', 'android', 'state-machine'));
      // `%ZZ` is not a valid escape sequence — decodeURIComponent throws on it.
      await writeFile(path.join(TEST_DIR, '%ZZ.json'), '{}');

      const ids = await store.list();

      expect(ids).toEqual(['list-valid']);
    });

    it('returns empty list when store directory does not exist (ENOENT)', async () => {
      await rm(TEST_DIR, { recursive: true, force: true });

      const ids = await store.list();

      expect(ids).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('sequential saves for same sessionId produce correct revision', async () => {
      const session = createSession('concurrent-same', 'android', 'state-machine');

      await Promise.all([store.save(session), store.save(session), store.save(session)]);

      expect(session.revision).toBe(3);
    });

    it('concurrent saves for different sessionIds both complete', async () => {
      const session1 = createSession('concurrent-diff-1', 'android', 'state-machine');
      const session2 = createSession('concurrent-diff-2', 'ios', 'state-machine');

      await Promise.all([store.save(session1), store.save(session2)]);

      expect(session1.revision).toBe(1);
      expect(session2.revision).toBe(1);
    });
  });
});
