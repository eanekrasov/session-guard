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
    expect(profile.schemas[0].source).toBe('android/session-guard.yaml');
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

describe('a circular extends chain', () => {
  it('is reported, not quietly truncated', async () => {
    // The walk used to `break` on a repeat, which kept it finite and told
    // nobody: the profile resolved half-assembled and then ran. A missing
    // parent has always thrown; a cycle is the same authoring mistake.
    await expect(resolveConfig('cycle-pair-a', FIXTURES_DIR)).rejects.toThrow(
      /circular extends chain: cycle-pair-a → cycle-pair-b → cycle-pair-a/
    );
  });

  it('is reported when a profile extends itself', async () => {
    await expect(resolveConfig('cycle-self', FIXTURES_DIR)).rejects.toThrow(
      /circular extends chain/
    );
  });
});

describe('agents along an extends chain', () => {
  it("adds the child's own agents to what its parent ships", async () => {
    // Inheritance used to stop at the nearest ancestor that declared any, so a
    // child naming one agent of its own silently lost every agent its parent
    // shipped — a profile could not add to what it extends.
    const profile = await resolveConfig('extends-child', FIXTURES_DIR);

    // The merged roster is a set of names: what it holds matters, the order it
    // holds them in does not.
    expect(profile.metadata.agents?.slice().sort()).toEqual(['architect', 'code', 'figma']);
  });

  it("keeps a name both of them carry once, and resolves it to the child's", async () => {
    const parent = await resolveConfig('extends-parent', FIXTURES_DIR);
    const child = await resolveConfig('extends-child', FIXTURES_DIR);

    expect(parent.metadata.agents).toEqual(['code', 'architect']);
    // `code` is declared by the parent only here; were both to declare it, the
    // child's entry comes first and the duplicate is dropped.
    expect(child.metadata.agents?.filter((a) => a === 'code')).toHaveLength(1);
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
    expect(base!.schemas).toContain('session-guard.yaml');
  });
});
