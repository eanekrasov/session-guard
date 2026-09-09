import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  listSessionIds,
  readAllSessions,
  readSession,
  sessionFileName,
  sessionIdFromFileName,
} from '../../src/session/session-files.ts';
import { createSession } from '../../src/session/session-store.ts';
import { WorkflowSessionSchema } from '../../src/session/session-schema.ts';

const TEST_DIR = path.join('/tmp', 'session-files-test-' + randomUUID());

async function writeSession(id: string): Promise<void> {
  const session = WorkflowSessionSchema.parse(createSession(id, 'android', 'session-guard'));
  await writeFile(path.join(TEST_DIR, sessionFileName(id)), JSON.stringify(session));
}

describe('session files', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('the naming rule', () => {
    it('round-trips an id that contains the extension', () => {
      // `encodeURIComponent` leaves a dot alone, so `a.jsonb.json` is a real
      // file name. Stripping the extension by first match reported `ab.json`.
      expect(sessionFileName('a.jsonb')).toBe('a.jsonb.json');
      expect(sessionIdFromFileName('a.jsonb.json')).toBe('a.jsonb');
    });

    it('round-trips an id that needs escaping', () => {
      const id = 'ses/1 2%3';
      expect(sessionIdFromFileName(sessionFileName(id))).toBe(id);
    });

    it('answers null for a name that is not a session file', () => {
      expect(sessionIdFromFileName('%ZZ.json')).toBeNull();
      expect(sessionIdFromFileName('notes.txt')).toBeNull();
      expect(sessionIdFromFileName('ses-1.json.lock')).toBeNull();
    });
  });

  describe('listSessionIds', () => {
    it('skips a name it cannot decode instead of failing the listing', async () => {
      await writeSession('alpha');
      await writeSession('beta');
      await writeFile(path.join(TEST_DIR, '%ZZ.json'), '{}');

      expect(await listSessionIds(TEST_DIR)).toEqual(['alpha', 'beta']);
    });

    it('names nothing when the directory does not exist', async () => {
      expect(await listSessionIds(path.join(TEST_DIR, 'absent'))).toEqual([]);
    });
  });

  describe('readSession', () => {
    it('reads a session the current schema accepts', async () => {
      await writeSession('read-me');

      const session = await readSession(TEST_DIR, 'read-me');

      expect(session?.sessionId).toBe('read-me');
      expect(session?.profileId).toBe('android');
    });

    it('answers null for an absent, unparseable or off-schema file', async () => {
      await writeFile(path.join(TEST_DIR, sessionFileName('broken')), '{ not json');
      await writeFile(path.join(TEST_DIR, sessionFileName('foreign')), '{"hello":"world"}');

      expect(await readSession(TEST_DIR, 'absent')).toBeNull();
      expect(await readSession(TEST_DIR, 'broken')).toBeNull();
      expect(await readSession(TEST_DIR, 'foreign')).toBeNull();
    });
  });

  describe('readAllSessions', () => {
    it('keys every readable session by id and leaves the rest out', async () => {
      await writeSession('one');
      await writeSession('two');
      await writeFile(path.join(TEST_DIR, sessionFileName('broken')), '{ not json');
      await writeFile(path.join(TEST_DIR, '%ZZ.json'), '{}');

      const sessions = await readAllSessions(TEST_DIR);

      expect(Object.keys(sessions)).toEqual(['one', 'two']);
      expect(sessions['one']?.sessionId).toBe('one');
    });
  });
});
