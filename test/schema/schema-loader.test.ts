import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

import { SchemaLoader, loadSchemaFromPath } from '../../src/schema/schema-loader.ts';
import { ProfileConfigurationError } from '../../src/schema/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'profiles');
const schemaFixturesDir = path.resolve(__dirname, '..', 'fixtures', 'schemas');

describe('SchemaLoader', () => {
  describe('loadSchemaFile', () => {
    it('returns null for non-existent schema file (does not throw)', async () => {
      const loader = new SchemaLoader(fixturesDir);

      const result = await loader.loadSchemaFile('base', 'non-existent.yaml');

      expect(result).toBeNull();
    });

    it('loads and parses an existing YAML schema file', async () => {
      const loader = new SchemaLoader(fixturesDir);

      const result = await loader.loadSchemaFile('base', 'state-machine.yaml');

      expect(result).not.toBeNull();
      expect(result!.stages).toBeDefined();
      expect(result!.stages!.planning).toBeDefined();
    });

    it('loads schema from a direct path', async () => {
      const result = await loadSchemaFromPath(schemaFixturesDir, 'base.yaml');

      expect(result).not.toBeNull();
      expect(result!.stages).toBeDefined();
    });

    it('wraps schema diagnostics with the profile, file, and issue path', async () => {
      const profilesDir = await mkdtemp(path.join(tmpdir(), 'state-machine-invalid-profile-'));
      const profileDir = path.join(profilesDir, 'invalid');
      await mkdir(profileDir);
      await writeFile(
        path.join(profileDir, 'task-cycles.yaml'),
        'stages:\n  execution:\n    dispatch:\n      strategy: serial\n      maxConcurrent: 1\n'
      );

      const loader = new SchemaLoader(profilesDir);

      await expect(loader.loadSchemaFile('invalid', 'task-cycles.yaml')).rejects.toMatchObject({
        name: 'ProfileConfigurationError',
        profileId: 'invalid',
        schemaFilename: 'task-cycles.yaml',
        path: 'stages.execution.dispatch.maxConcurrent',
      } satisfies Partial<ProfileConfigurationError>);
    });
  });

  describe('resolveSchemaChain (mixed merge)', () => {
    it('merges schemas with settings deep-merge while inheriting rest', async () => {
      // Android extends base, so its schemas are in android/ but
      // its extends chain includes base's schemas.

      const schemaLoader = new SchemaLoader(fixturesDir);

      // First load the android schema (which extends base/state-machine.yaml)
      // Then load the base schema as its base
      // The merge: android's gateMapping should override base's, but
      // settings and transitions should inherit from base where android doesn't specify.

      const androidSchema = await schemaLoader.loadSchemaFile('android', 'state-machine.yaml');
      expect(androidSchema).not.toBeNull();

      const baseSchema = await schemaLoader.loadSchemaFile('base', 'state-machine.yaml');
      expect(baseSchema).not.toBeNull();

      // Now merge them
      const merged = schemaLoader.mergeSchemas(baseSchema!, androidSchema!);

      // settings should be deep merged — mutationTtlMs overridden, retryMaxAttempts inherited
      expect(merged.settings!.mutationTtlMs).toBe(600000);
      expect(merged.settings!.retryMaxAttempts).toBe(3);

      // transitions should be overridden by android
      expect(merged.transitions).toBeDefined();
    });
  });
});
