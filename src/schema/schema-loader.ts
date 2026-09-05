import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { z } from 'zod';

import { ProfileSchemaSchema } from './profile-schema.ts';
import { ProfileConfigurationError, type ProfileSchema, type ResolvedSchema } from './types.ts';

/**
 * Load a ProfileSchema from an arbitrary path. Returns null when the file
 * does not exist or fails to validate.
 */
export async function loadSchemaFromPath(
  dir: string,
  filename: string
): Promise<ProfileSchema | null> {
  const filePath = path.join(dir, filename);
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const raw = YAML.parse(await fs.readFile(filePath, 'utf-8'));
  return ProfileSchemaSchema.parse(raw);
}

export class SchemaLoader {
  private readonly profilesDir: string;

  constructor(profilesDir: string) {
    this.profilesDir = profilesDir;
  }

  /**
   * Load a schema file from a profile directory.
   * Returns null (instead of throwing) when the file does not exist.
   * Validates the parsed YAML against ProfileSchemaSchema.
   */
  async loadSchemaFile(profileId: string, schemaFilename: string): Promise<ProfileSchema | null> {
    const schemaPath = path.join(this.profilesDir, profileId, schemaFilename);

    try {
      await fs.access(schemaPath);
    } catch {
      return null;
    }

    const raw = YAML.parse(await fs.readFile(schemaPath, 'utf-8'));
    try {
      return ProfileSchemaSchema.parse(raw);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ProfileConfigurationError(
          profileId,
          schemaFilename,
          error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          }))
        );
      }
      throw error;
    }
  }

  /**
   * Merge two schemas. Extension fields override base when present.
   * Settings are deep-merged.
   */
  mergeSchemas(base: ProfileSchema, extension: ProfileSchema): ResolvedSchema {
    const result: ResolvedSchema = {
      source: extension.extends ?? '',
      phases: extension.phases ?? base.phases,
      transitions: extension.transitions ?? base.transitions,
      settings: this.deepMerge(base.settings ?? {}, extension.settings ?? {}),
      editingAgents: extension.editingAgents ?? base.editingAgents,
      verifiers: extension.verifiers ?? base.verifiers,
      requiredGates: extension.requiredGates ?? base.requiredGates,
      actionGuards: extension.actionGuards ?? base.actionGuards,
      phaseAssignments: extension.phaseAssignments ?? base.phaseAssignments,
    };

    // Strip undefined fields
    for (const key of Object.keys(result)) {
      const k = key as keyof ResolvedSchema;
      if (result[k] === undefined) {
        delete result[k];
      }
    }

    return result;
  }

  private deepMerge(
    base: Record<string, unknown>,
    extension: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(extension)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.deepMerge(
          (result[key] as Record<string, unknown>) ?? {},
          value as Record<string, unknown>
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
