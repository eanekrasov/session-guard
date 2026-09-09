import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

import { ProfileResolver } from '../../src/app/profile-resolver.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'profiles');

describe('ProfileResolver', () => {
  describe('resolve (missing extends)', () => {
    it('throws a fatal error when extended profile does not exist', async () => {
      const resolver = new ProfileResolver(fixturesDir);

      await expect(resolver.resolve('missing-extends')).rejects.toThrow(/non-existent-profile/i);
    });
  });

  describe('listProfiles', () => {
    it('discovers all profiles in the fixtures directory', async () => {
      const resolver = new ProfileResolver(fixturesDir);

      const profiles = await resolver.listProfiles();

      expect(profiles.length).toBeGreaterThanOrEqual(4);
      const profileIds = profiles.map((p) => p.id);
      expect(profileIds).toContain('base');
      expect(profileIds).toContain('android');
      expect(profileIds).toContain('ios');
      expect(profileIds).toContain('no-id-profile');
    });

    it('returns profiles with correct metadata fields', async () => {
      const resolver = new ProfileResolver(fixturesDir);

      const profiles = await resolver.listProfiles();
      const base = profiles.find((p) => p.id === 'base');

      expect(base).toBeDefined();
      expect(base!.description).toBe('Base development profile');
      expect(base!.agents).toEqual(['code', 'architect']);
      expect(base!.skills).toEqual(['code-review', 'testing']);
      expect(base!.invariants).toEqual(['no-console', 'strict-null']);
      expect(base!.schemas).toEqual(['session-guard.yaml']);
    });

    it('resolves default agentsDir and skillsDir for profiles without them', async () => {
      const resolver = new ProfileResolver(fixturesDir);

      const profiles = await resolver.listProfiles();
      const base = profiles.find((p) => p.id === 'base');

      expect(base).toBeDefined();
      expect(base!.agentsDir).toBe('agents');
      expect(base!.skillsDir).toBe('skills');
    });
  });

  describe('resolves id fallback to directory name', () => {
    it('uses directory name as id when profile.json has no id field', async () => {
      const resolver = new ProfileResolver(fixturesDir);

      const profiles = await resolver.listProfiles();
      const noIdProfile = profiles.find((p) => p.id === 'no-id-profile');

      expect(noIdProfile).toBeDefined();
      expect(noIdProfile!.id).toBe('no-id-profile');
    });
  });
});
