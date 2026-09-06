import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { loadSchemaFromPath } from '../../src/schema/schema-loader.ts';
import { ProfileSchemaSchema } from '../../src/schema/profile-schema.ts';

const FIXTURES_DIR = resolve(import.meta.dirname, 'presets');

interface PresetsConfig {
  stages: string[];
}

function loadPresetsConfig(): PresetsConfig {
  const raw = readFileSync(resolve(FIXTURES_DIR, 'default.yaml'), 'utf-8');
  return YAML.parse(raw) as PresetsConfig;
}

describe('default.yaml (PresetsConfig)', () => {
  it('loads 5 stages', () => {
    const config = loadPresetsConfig();
    expect(config.stages).toEqual(['PLANNING', 'TASKS_READY', 'EXECUTION', 'COMMIT', 'DONE']);
  });
});

describe('high.yaml (ProfileSchema)', () => {
  it('loads with full feature workflow stages', async () => {
    const schema = await loadSchemaFromPath(FIXTURES_DIR, 'high.yaml');
    expect(schema).not.toBeNull();
    expect(Object.keys(schema!.stages!)).toContain('PLANNING');
    expect(Object.keys(schema!.stages!)).toContain('EXECUTION');
    expect(Object.keys(schema!.stages!)).toContain('COMMIT');
    expect(Object.keys(schema!.stages!)).toContain('DONE');
    expect(schema!.transitions).toBeDefined();
    expect(schema!.transitions!.length).toBeGreaterThan(0);
  });

  it('has actionGuards for beginMutation', async () => {
    const schema = await loadSchemaFromPath(FIXTURES_DIR, 'high.yaml');
    expect(schema!.actionGuards).toBeDefined();
    expect(schema!.actionGuards!['beginMutation']).toBeTruthy();
  });
});

describe('medium.yaml', () => {
  it('loads with stages and transitions', async () => {
    const schema = await loadSchemaFromPath(FIXTURES_DIR, 'medium.yaml');
    expect(schema).not.toBeNull();
    expect(schema!.transitions).toBeDefined();
  });
});

describe('low.yaml', () => {
  it('has no TASKS_READY stage', async () => {
    const schema = await loadSchemaFromPath(FIXTURES_DIR, 'low.yaml');
    expect(Object.keys(schema!.stages!)).not.toContain('TASKS_READY');
  });

  it('has no actionGuards', async () => {
    const schema = await loadSchemaFromPath(FIXTURES_DIR, 'low.yaml');
    expect(schema!.actionGuards).toBeUndefined();
  });
});

describe('validation', () => {
  it('high, medium, low validate against ProfileSchemaSchema', async () => {
    for (const file of ['high.yaml', 'medium.yaml', 'low.yaml']) {
      const schema = await loadSchemaFromPath(FIXTURES_DIR, file);
      expect(schema).not.toBeNull();
      expect(() => ProfileSchemaSchema.parse(schema)).not.toThrow();
    }
  });
});
