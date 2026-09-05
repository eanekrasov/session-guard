import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { resolveConfig, listProfiles } from '../src/public-api.ts';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures', 'profiles');

describe('resolveConfig', () => {
  it('resolves android profile with base inheritance (agents, skills, invariants)', async () => {
    const profile = await resolveConfig('android', FIXTURES_DIR);

    // Metadata
    expect(profile.metadata.id).toBe('android');
    expect(profile.metadata.description).toBe('Android development profile');

    // agents, skills, invariants — inherited from base
    expect(profile.metadata.agents).toEqual(['code', 'architect']);
    expect(profile.metadata.skills).toEqual(['code-review', 'testing']);
    expect(profile.metadata.invariants).toEqual(['no-console', 'strict-null']);

    // agentsDir, skillsDir — from extending profile, NOT inherited
    expect(profile.metadata.agentsDir).toBe('custom-agents');
    expect(profile.metadata.skillsDir).toBe('custom-skills');

    // Schemas
    expect(profile.schemas).toHaveLength(1);
    expect(profile.schemas[0].source).toBe('android/state-machine.yaml');
  });

  it('resolves base profile directly (no extends)', async () => {
    const profile = await resolveConfig('base', FIXTURES_DIR);

    expect(profile.metadata.id).toBe('base');
    expect(profile.metadata.agents).toEqual(['code', 'architect']);
    expect(profile.metadata.skills).toEqual(['code-review', 'testing']);
    expect(profile.metadata.invariants).toEqual(['no-console', 'strict-null']);
    expect(profile.metadata.agentsDir).toBe('agents');

    // base has no extends — 1 source schema
    expect(profile.schemas).toHaveLength(1);
  });
});

describe('listProfiles', () => {
  it('lists all available profiles', async () => {
    const profiles = await listProfiles(FIXTURES_DIR);

    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('base');
    expect(ids).toContain('android');
    expect(ids).toContain('ios');
    expect(ids).toContain('no-id-profile');
  });

  it('returns profiles with correct metadata', async () => {
    const profiles = await listProfiles(FIXTURES_DIR);
    const base = profiles.find((p) => p.id === 'base');

    expect(base).toBeDefined();
    expect(base!.agents).toEqual(['code', 'architect']);
    expect(base!.schemas).toContain('state-machine.yaml');
  });
});
