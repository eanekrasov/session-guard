import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { z } from 'zod';

import { ProfileSchemaSchema } from './profile-schema.ts';
import type { StageDef, TransitionDef } from './types.ts';
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

/**
 * Merge stage maps entry by entry, and each entry field by field.
 *
 * A child that names a stage is refining it, not replacing it: overriding a
 * roster must not drop the loop, the nested stages or the transitions the
 * parent declared for that same stage. Nested stages merge by the same rule at
 * any depth.
 */
export function mergeStages(
  base: ProfileSchema['stages'],
  extension: ProfileSchema['stages']
): ProfileSchema['stages'] {
  if (!base) return extension;
  if (!extension) return base;
  const result = { ...base };
  for (const [stageId, override] of Object.entries(extension)) {
    const inherited = base[stageId];
    result[stageId] = inherited ? mergeStage(inherited, override) : override;
  }
  return result;
}

function mergeStage(base: StageDef, extension: StageDef): StageDef {
  return {
    ...base,
    ...extension,
    ...(base.stages || extension.stages
      ? { stages: mergeStages(base.stages, extension.stages) }
      : {}),
    ...(base.transitions || extension.transitions
      ? { transitions: mergeTransitions(base.transitions, extension.transitions) }
      : {}),
  };
}

/**
 * Merge transition lists by their endpoints: a child redeclaring `a → b`
 * replaces the parent's edges for that pair and leaves every other pair alone.
 *
 * A pair may carry several edges, told apart by their guards — one for the
 * gates that passed and one for the gates that failed. Keying a single edge per
 * pair collapsed them: two `a → b` edges became the last one declared, and the
 * alternative was gone before the engine ever saw it, so a session sat in `a`
 * with an edge that could never fire. A child's redeclaration replaces the
 * parent's group as a whole — replacing one edge of a pair and keeping the
 * others would leave a parent's guard behind a child that meant to supersede it.
 */
export function mergeTransitions(
  base: TransitionDef[] | undefined,
  extension: TransitionDef[] | undefined
): TransitionDef[] | undefined {
  if (!base) return extension;
  if (!extension) return base;

  const edge = (transition: TransitionDef): string => `${transition.from}→${transition.to}`;
  const order: string[] = [];
  const groups = new Map<string, TransitionDef[]>();

  for (const transition of base) {
    const key = edge(transition);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(transition);
  }

  const replacements = new Map<string, TransitionDef[]>();
  for (const transition of extension) {
    const key = edge(transition);
    if (!replacements.has(key)) {
      replacements.set(key, []);
      if (!groups.has(key)) order.push(key);
    }
    replacements.get(key)!.push(transition);
  }
  for (const [key, list] of replacements) groups.set(key, list);

  return order.flatMap((key) => groups.get(key) ?? []);
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
   *
   * Stages and transitions merge per entry, not as whole fields: a profile
   * that extends another is a delta over it, and replacing the whole map would
   * mean a child touching one stage silently drops every other stage — and
   * every transition that named them — from its parent.
   *
   * Settings are deep-merged.
   */
  mergeSchemas(base: ProfileSchema, extension: ProfileSchema): ResolvedSchema {
    const result: ResolvedSchema = {
      // An intermediate: the identity belongs to the file the resolver was
      // asked for, and it stamps both `id` and `source` on the way out.
      id: '',
      source: extension.extends ?? '',
      stages: mergeStages(base.stages, extension.stages),
      transitions: mergeTransitions(base.transitions, extension.transitions),
      editingAgents: extension.editingAgents ?? base.editingAgents,
      gates: extension.gates ?? base.gates,
      taskControlAgents: extension.taskControlAgents ?? base.taskControlAgents,
      stageAssignments: extension.stageAssignments ?? base.stageAssignments,
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
