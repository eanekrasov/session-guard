import fs from 'fs/promises';
import path from 'path';
import { ProfileMetadataSchema } from '../schema/profile-metadata.ts';
import { listProfileAgents } from './profile-agent-sync.ts';
import type {
  ProfileMetadata,
  LoadedProfile,
  StageDef,
  ResolvedSchema,
  ResolvedProfile,
} from '../schema/types.ts';
import type { ProfileSchema } from '../schema/profile-schema.ts';
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

    // A profile's schemas are its own. Schemas combine only through a
    // schema-level `extends`, so unioning the chain's lists would put a
    // parent's workflow beside the child's delta as a second, independent
    // schema — and the session would then have to choose between them.
    // A profile that declares none inherits the nearest ancestor's list, the
    // same way its agents and skills are inherited.
    let schemaFiles = primary.schemas;
    if (schemaFiles === undefined) {
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].schemas) {
          schemaFiles = chain[i].schemas;
          break;
        }
      }
    }
    const allSchemas = new Set<string>(schemaFiles ?? []);

    let skills = primary.skills;
    let invariants = primary.invariants;

    /**
     * Agents accumulate down the chain; they are not inherited whole.
     *
     * This used to take the nearest ancestor that declared any, so a child
     * naming one agent of its own silently lost every agent its parent
     * shipped, and a child naming none inherited the parent's list rather than
     * its own files. Both readings were surprising in the same direction: a
     * profile could not add to what it extends.
     *
     * Each link contributes what it ships — its declared `agents`, or the
     * prompts in its own agents directory when it declares none. The child
     * comes first, so a name both of them carry resolves to the child's.
     */
    const agents: string[] = [];
    for (const link of chain) {
      const id = link.id;
      if (id === undefined) continue;
      for (const agent of await listProfileAgents(id, this.profilesDir)) {
        if (!agents.includes(agent)) agents.push(agent);
      }
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
   * Resolve a profile's extends chain: [extending, ...extended].
   *
   * A cycle is a configuration error and is reported as one. It used to end
   * the walk with a bare `break`, which kept the loop finite and told nobody:
   * `a extends b` and `b extends a` resolved to a half-assembled profile that
   * then ran. The missing-parent case two lines below has always thrown — a
   * cycle is the same mistake by the same author and deserves the same answer.
   */
  /**
   * Цепочка профилей от самого до корня предка, в порядке наследования.
   *
   * Публична, потому что метаданные наследуются по ней, а файлы, на которые
   * они ссылаются, лежат у того предка, который их объявил: `smoke` наследует
   * от `base` СПИСОК инвариантов, а `invariants.ts` живёт в `base`.
   */
  async profileChain(profileId: string): Promise<LoadedProfile[]> {
    return this.resolveProfileExtends(profileId);
  }

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
      if (visited.has(currentExtends)) {
        const cycle = [...visited, currentExtends].join(' → ');
        throw new Error(`Profile "${profileId}" has a circular extends chain: ${cycle}`);
      }

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
    const owner = chain.find((profile) => profile.schemas?.includes(schemaFile));
    const currentSchema = owner
      ? await this.resolveInheritedSchema(owner.id, schemaFile, chain, new Set())
      : null;

    if (!currentSchema) {
      // A schema a profile declares and does not have is a defect in the
      // profile, not an empty workflow. Returning a stub here made
      // `workflow.create` report success and persist a session with
      // `currentStage: ''` — a session under a state machine with no states.
      throw new Error(
        `Profile "${chain[0].id}" declares schema "${schemaFile}", but no profile in its ` +
          `extends chain [${chain.map((profile) => profile.id).join(' → ')}] has that file`
      );
    }

    return {
      id: schemaId(schemaFile),
      source: `${chain[0].id}/${schemaFile}`,
      stages: qualifyStageAgents(chain[0].id, currentSchema.stages),
      transitions: currentSchema.transitions,
      editingAgents: currentSchema.editingAgents,
      gates: currentSchema.gates,
      taskControlAgents: currentSchema.taskControlAgents,
      stageAssignments: currentSchema.stageAssignments,
    };
  }

  /**
   * Load a schema from the first profile in the chain that has it.
   */
  /**
   * One schema with its whole `extends` chain folded in.
   *
   * The parent used to be loaded raw — `loadSchemaFile`, not resolved — so
   * only one level of inheritance survived. In a chain C → B → A, B kept A's
   * stages and C lost them: a stage declared in the grandparent simply
   * disappeared. Resolving the parent the same way this resolves the child is
   * what makes the chain a chain.
   */
  private async resolveInheritedSchema(
    profileId: string,
    schemaFile: string,
    chain: LoadedProfile[],
    seen: Set<string>
  ): Promise<ProfileSchema | null> {
    const key = `${profileId}/${schemaFile}`;
    if (seen.has(key)) {
      throw new Error(`Schema extends itself through ${[...seen, key].join(' → ')}`);
    }
    seen.add(key);

    const raw = await this.schemaLoader.loadSchemaFile(profileId, schemaFile);
    if (!raw?.extends) return raw;

    const slashIndex = raw.extends.indexOf('/');
    if (slashIndex === -1) return raw;
    const parentProfileId = raw.extends.substring(0, slashIndex);
    const parentSchemaFile = raw.extends.substring(slashIndex + 1);
    if (!chain.some((profile) => profile.id === parentProfileId)) return raw;

    const parent = await this.resolveInheritedSchema(
      parentProfileId,
      parentSchemaFile,
      chain,
      seen
    );
    return parent ? this.schemaLoader.mergeSchemas(parent, raw) : raw;
  }
}

/**
 * A schema's name within its profile: the file name without its extension.
 *
 * Profiles declare their schemas as file names, but a session names one as
 * `<profileId>/<schemaId>`, and an extension there would be noise.
 */
export function schemaId(schemaFile: string): string {
  return schemaFile.replace(/\.ya?ml$/i, '');
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
