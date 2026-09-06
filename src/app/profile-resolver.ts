import fs from 'fs/promises';
import path from 'path';
import { ProfileMetadataSchema } from '../schema/profile-metadata.ts';
import type {
  ProfileMetadata,
  LoadedProfile,
  StageDef,
  ResolvedSchema,
  ResolvedProfile,
} from '../schema/types.ts';
import { SchemaLoader } from '../schema/schema-loader.ts';
import { qualifyAgentName } from './agent-names.ts';

/**
 * ProfileResolver — resolves a profile's full configuration by:
 * 1. Loading profile metadata
 * 2. Resolving the extends chain (profile-level + schema-level)
 */
export class ProfileResolver {
  private readonly profilesDir: string;
  private readonly schemaLoader: SchemaLoader;
  private profileCache: LoadedProfile[] | null = null;

  constructor(profilesDir: string) {
    this.profilesDir = profilesDir;
    this.schemaLoader = new SchemaLoader(profilesDir);
  }

  /**
   * Resolve a profile's full configuration.
   * Returns merged metadata + resolved schemas.
   */
  async resolve(profileId: string): Promise<ResolvedProfile> {
    const chain = await this.resolveProfileExtends(profileId);

    // Build metadata
    const primary = chain[0];
    const agentsDir = primary.agentsDir;
    const skillsDir = primary.skillsDir;
    const description = primary.description;

    // The chain runs [extending, ...extended], but the resolved schema list is
    // merged last-wins. Walk it from the root outwards so an extending profile's
    // own schema is resolved last and can override what it inherits.
    const allSchemas = new Set<string>();
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const s of chain[i].schemas ?? []) allSchemas.add(s);
    }

    let agents = primary.agents;
    let skills = primary.skills;
    let invariants = primary.invariants;

    if (agents === undefined) {
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].agents) {
          agents = chain[i].agents;
          break;
        }
      }
      agents = agents ?? [];
    }
    if (skills === undefined) {
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].skills) {
          skills = chain[i].skills;
          break;
        }
      }
      skills = skills ?? [];
    }
    if (invariants === undefined) {
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].invariants) {
          invariants = chain[i].invariants;
          break;
        }
      }
      invariants = invariants ?? [];
    }

    // Resolve schemas
    const schemas = await this.resolveSchemas(chain, allSchemas);

    return {
      metadata: {
        id: primary.id!,
        description,
        agents,
        skills,
        invariants,
        agentsDir: agentsDir ?? '',
        skillsDir: skillsDir ?? '',
      },
      schemas,
    };
  }

  /**
   * List all available profiles (flat, no extends resolution).
   */
  async listProfiles(): Promise<ProfileMetadata[]> {
    const loaded = await this.loadAll();
    return loaded.map((p) => ({
      id: p.id,
      description: p.description,
      extends: p.extends,
      schemas: p.schemas,
      agentsDir: p.agentsDir,
      skillsDir: p.skillsDir,
      agents: p.agents,
      skills: p.skills,
      invariants: p.invariants,
    }));
  }

  /**
   * Load all profiles from disk. Cached after first call.
   */
  private async loadAll(): Promise<LoadedProfile[]> {
    if (this.profileCache) return this.profileCache;

    let entries: string[];
    try {
      entries = await fs.readdir(this.profilesDir);
    } catch (err) {
      console.error('[ERROR] ProfileResolver.loadAll: cannot read profilesDir', {
        profilesDir: this.profilesDir,
        error: err instanceof Error ? err.message : String(err),
      });
      this.profileCache = [];
      return this.profileCache;
    }

    const profiles: LoadedProfile[] = [];
    for (const entry of entries) {
      const profileDir = path.join(this.profilesDir, entry);
      const profileJsonPath = path.join(profileDir, 'profile.json');

      try {
        const stat = await fs.stat(profileJsonPath);
        if (!stat.isFile()) continue;
      } catch {
        // Profile directory exists but has no profile.json — skip silently
        continue;
      }

      const raw = JSON.parse(await fs.readFile(profileJsonPath, 'utf-8'));
      if (raw.id === undefined || raw.id === null) raw.id = entry;

      const parsed = ProfileMetadataSchema.parse(raw);
      profiles.push({
        id: parsed.id,
        description: parsed.description,
        extends: parsed.extends,
        schemas: parsed.schemas,
        agentsDir: parsed.agentsDir,
        skillsDir: parsed.skillsDir,
        agents: parsed.agents,
        skills: parsed.skills,
        invariants: parsed.invariants,
      });
    }

    this.profileCache = profiles;
    return profiles;
  }

  /**
   * Resolve a profile's extends chain.
   * Returns [extending, ...extended] with cycle detection.
   */
  private async resolveProfileExtends(profileId: string): Promise<LoadedProfile[]> {
    const profiles = await this.loadAll();
    const profile = profiles.find((p) => p.id === profileId);

    if (!profile) {
      throw new Error(`Profile "${profileId}" not found`);
    }

    if (!profile.extends) {
      return [profile];
    }

    const chain: LoadedProfile[] = [profile];
    const visited = new Set<string>();
    visited.add(profile.id);

    let currentExtends = profile.extends;
    while (currentExtends) {
      if (visited.has(currentExtends)) break;

      visited.add(currentExtends);
      const extended = profiles.find((p) => p.id === currentExtends);

      if (!extended) {
        throw new Error(
          `Profile "${profileId}" extends "${currentExtends}" but that profile does not exist`
        );
      }

      chain.push(extended);
      currentExtends = extended.extends ?? '';
    }

    return chain;
  }

  /**
   * Resolve all schemas across the extends chain.
   * For each schema file, find it in the chain and resolve its schema-level extends.
   */
  private async resolveSchemas(
    chain: LoadedProfile[],
    schemaFiles: Set<string>
  ): Promise<ResolvedSchema[]> {
    const resolved: ResolvedSchema[] = [];

    for (const schemaFile of schemaFiles) {
      resolved.push(await this.resolveSingleSchema(schemaFile, chain));
    }

    return resolved;
  }

  /**
   * Resolve a single schema file: load from the chain, merge schema-level extends.
   */
  private async resolveSingleSchema(
    schemaFile: string,
    chain: LoadedProfile[]
  ): Promise<ResolvedSchema> {
    let currentSchema = await this.loadSchemaFromChain(schemaFile, chain);

    if (!currentSchema) {
      return { source: `${chain[0].id}/${schemaFile}` };
    }

    if (currentSchema.extends) {
      const slashIndex = currentSchema.extends.indexOf('/');
      if (slashIndex !== -1) {
        const extendedProfileId = currentSchema.extends.substring(0, slashIndex);
        const extendedSchemaFile = currentSchema.extends.substring(slashIndex + 1);
        const extendedProfile = chain.find((p) => p.id === extendedProfileId);

        if (extendedProfile) {
          const baseSchema = await this.schemaLoader.loadSchemaFile(
            extendedProfileId,
            extendedSchemaFile
          );
          if (baseSchema) {
            currentSchema = this.schemaLoader.mergeSchemas(baseSchema, currentSchema);
          }
        }
      }
    }

    return {
      source: `${chain[0].id}/${schemaFile}`,
      stages: qualifyStageAgents(chain[0].id, currentSchema.stages),
      transitions: currentSchema.transitions,
      settings: currentSchema.settings,
      editingAgents: currentSchema.editingAgents,
      verifiers: currentSchema.verifiers,
      requiredGates: currentSchema.requiredGates,
      taskControlAgents: currentSchema.taskControlAgents,
      actionGuards: currentSchema.actionGuards,
      stageAssignments: currentSchema.stageAssignments,
    };
  }

  /**
   * Load a schema from the first profile in the chain that has it.
   */
  private async loadSchemaFromChain(schemaFile: string, chain: LoadedProfile[]) {
    for (const profile of chain) {
      if (profile.schemas?.includes(schemaFile)) {
        const schema = await this.schemaLoader.loadSchemaFile(profile.id, schemaFile);
        if (schema) return schema;
      }
    }
    return null;
  }
}

/**
 * Qualify every `allowedAgents` entry with the owning profile id.
 *
 * Schemas are authored with bare agent names, but synced agents register under
 * `<profileId>/<name>` (see agent-names.ts). Qualifying at resolution keeps the
 * YAML readable while letting the runtime compare against the host's names.
 */
function qualifyStageAgents(
  profileId: string,
  stages: Record<string, StageDef> | undefined
): Record<string, StageDef> | undefined {
  if (!stages) return stages;
  const result: Record<string, StageDef> = {};
  for (const [stageId, def] of Object.entries(stages)) {
    result[stageId] = {
      ...def,
      ...(def.allowedAgents
        ? { allowedAgents: def.allowedAgents.map((a) => qualifyAgentName(profileId, a)) }
        : {}),
      // Nested stages are stages: the same qualification applies at any depth.
      ...(def.stages ? { stages: qualifyStageAgents(profileId, def.stages) } : {}),
    };
  }
  return result;
}
