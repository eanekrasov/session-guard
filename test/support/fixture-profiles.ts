import { resolve } from 'node:path';

export function fixtureProfilesDir(...segments: string[]): string {
  return resolve(import.meta.dir, '../fixtures', ...segments);
}

export function setFixtureProfilesDir(): void {
  process.env.SESSION_GUARD_PROFILES_DIR = fixtureProfilesDir('profiles');
}
