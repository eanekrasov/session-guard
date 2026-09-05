import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveConfig, listProfiles } from '../../src/public-api.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'profiles');

describe('Public API', () => {
  describe('resolveConfig', () => {
    it('resolves a profile with no extends (standalone)', async () => {
      const result = await resolveConfig('base', fixturesDir);

      expect(result.metadata.id).toBe('base');
      expect(result.metadata.agents).toEqual(['code', 'architect']);
      expect(result.metadata.skills).toEqual(['code-review', 'testing']);
      expect(result.metadata.invariants).toEqual(['no-console', 'strict-null']);
      expect(result.metadata.agentsDir).toBe('agents');
      expect(result.metadata.skillsDir).toBe('skills');
      expect(result.schemas).toHaveLength(1);
    });

    it('resolves a profile with full two-level extends chain', async () => {
      // android extends base
      // android/state-machine.yaml extends base/state-machine.yaml
      const result = await resolveConfig('android', fixturesDir);

      // Metadata — android extends base
      expect(result.metadata.id).toBe('android');
      // agents, skills, invariants inherited from base (android doesn't define its own)
      expect(result.metadata.agents).toEqual(['code', 'architect']);
      expect(result.metadata.skills).toEqual(['code-review', 'testing']);
      expect(result.metadata.invariants).toEqual(['no-console', 'strict-null']);
      // agentsDir and skillsDir from android itself (not inherited)
      expect(result.metadata.agentsDir).toBe('custom-agents');
      expect(result.metadata.skillsDir).toBe('custom-skills');

      // Schemas — android's schema extends base's schema;
      // since both profile and extended profile list the same schema filename,
      // they are combined into one resolved schema (with extends merged)
      expect(result.schemas).toHaveLength(1);
      expect(result.schemas[0].source).toBe('android/state-machine.yaml');
      // settings deep merged: mutationTtlMs overridden by android
      expect(result.schemas[0].settings!.mutationTtlMs).toBe(600000);
      expect(result.schemas[0].settings!.retryMaxAttempts).toBe(3);
    });

    it('throws for unknown profileId', async () => {
      await expect(resolveConfig('non-existent', fixturesDir)).rejects.toThrow();
    });
  });

  describe('listProfiles', () => {
    it('returns all profiles with required fields', async () => {
      const profiles = await listProfiles(fixturesDir);

      expect(profiles.length).toBeGreaterThanOrEqual(4);

      for (const p of profiles) {
        expect(p).toHaveProperty('id');
        expect(typeof p.id).toBe('string');

        // id must be non-empty string
        expect(p.id.length).toBeGreaterThan(0);
      }
    });

    it('returns profiles with optional fields when present', async () => {
      const profiles = await listProfiles(fixturesDir);
      const base = profiles.find((p) => p.id === 'base');

      expect(base).toBeDefined();
      expect(base!.description).toBe('Base development profile');
      expect(base!.extends).toBeUndefined();
      expect(base!.schemas).toEqual(['state-machine.yaml']);
      expect(base!.agentsDir).toBe('agents');
      expect(base!.skillsDir).toBe('skills');
      expect(base!.agents).toEqual(['code', 'architect']);
      expect(base!.skills).toEqual(['code-review', 'testing']);
      expect(base!.invariants).toEqual(['no-console', 'strict-null']);
    });

    it('returns profiles without extends', async () => {
      const profiles = await listProfiles(fixturesDir);
      const base = profiles.find((p) => p.id === 'base');

      expect(base!.extends).toBeUndefined();
    });
  });
});
