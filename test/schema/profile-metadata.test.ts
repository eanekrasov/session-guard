import { describe, it, expect } from 'vitest';

// RED: Reference production code that does NOT exist yet
import { ProfileMetadataSchema } from '../../src/schema/profile-metadata.ts';

describe('ProfileMetadataSchema', () => {
  it('strips unknown fields like "extended"', () => {
    const input = {
      id: 'test',
      extended: 'base', // unknown field, should be stripped
      agentsDir: 'my-agents',
      skillsDir: 'my-skills',
    };

    const result = ProfileMetadataSchema.parse(input);

    expect(result.id).toBe('test');
    expect(result.agentsDir).toBe('my-agents');
    expect(result.skillsDir).toBe('my-skills');
    // The unknown field must be stripped by .strip()
    expect((result as Record<string, unknown>).extended).toBeUndefined();
  });

  it('applies default agentsDir when not provided', () => {
    const input = {
      id: 'test',
      skillsDir: 'my-skills',
    };

    const result = ProfileMetadataSchema.parse(input);

    expect(result.agentsDir).toBe('agents');
    expect(result.skillsDir).toBe('my-skills');
  });

  it('applies default skillsDir when not provided', () => {
    const input = {
      id: 'test',
      agentsDir: 'my-agents',
    };

    const result = ProfileMetadataSchema.parse(input);

    expect(result.agentsDir).toBe('my-agents');
    expect(result.skillsDir).toBe('skills');
  });

  it('rejects invalid field types', () => {
    const input = {
      id: 'test',
      agents: 'not-an-array', // should be string[]
    };

    expect(() => ProfileMetadataSchema.parse(input)).toThrow();
  });

  it('accepts valid metadata with all fields', () => {
    const input = {
      id: 'android',
      description: 'Android dev profile',
      extends: 'base',
      schemas: ['state-machine.yaml'],
      agentsDir: 'custom-agents',
      skillsDir: 'custom-skills',
      agents: ['code', 'architect'],
      skills: ['code-review'],
      invariants: ['no-console'],
    };

    const result = ProfileMetadataSchema.parse(input);

    expect(result.id).toBe('android');
    expect(result.description).toBe('Android dev profile');
    expect(result.extends).toBe('base');
    expect(result.schemas).toEqual(['state-machine.yaml']);
    expect(result.agentsDir).toBe('custom-agents');
    expect(result.skillsDir).toBe('custom-skills');
    expect(result.agents).toEqual(['code', 'architect']);
    expect(result.skills).toEqual(['code-review']);
    expect(result.invariants).toEqual(['no-console']);
  });

  it('accepts metadata without optional fields', () => {
    const input = {
      id: 'minimal',
    };

    const result = ProfileMetadataSchema.parse(input);

    expect(result.id).toBe('minimal');
    expect(result.agentsDir).toBe('agents');
    expect(result.skillsDir).toBe('skills');
    expect(result.agents).toBeUndefined();
    expect(result.skills).toBeUndefined();
    expect(result.invariants).toBeUndefined();
  });
});
