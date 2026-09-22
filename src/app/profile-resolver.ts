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
 * ProfileResolver — резолвит полную конфигурацию профиля:
 * 1. Загружает метаданные профиля
 * 2. Резолвит цепочку extends (на уровне профиля + на уровне схемы)
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
   * Резолвить полную конфигурацию профиля.
   * Возвращает смерженные метаданные + резолвленные схемы.
   */
  async resolve(profileId: string): Promise<ResolvedProfile> {
    const chain = await this.resolveProfileExtends(profileId);

    // Build metadata
    const primary = chain[0];
    const agentsDir = primary.agentsDir;
    const skillsDir = primary.skillsDir;
    const description = primary.description;

    // Схемы профиля — свои. Схемы комбинируются только через schema-level `extends`,
    // так что объединение списков цепочки положило бы workflow родителя рядом с
    // дельтой ребёнка как вторую независимую схему — и сессии пришлось бы
    // выбирать между ними. Профиль, не декларирующий своих, наследует список
    // ближайшего предка, так же как его агенты и скиллы.
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
     * Агенты аккумулируются вниз по цепочке; они не наследуются целиком.
     *
     * Раньше это брало ближайшего предка, который декларировал хоть что-то,
     * так что ребёнок, называющий своего агента, молча терял всех агентов,
     * которых шел родитель, а ребёнок, не называющий своих, наследовал список
     * родителя вместо своих файлов. Оба чтения были удивительны в одном
     * направлении: профиль не мог добавить к тому, что он расширяет.
     *
     * Каждая звено вносит то, что у него — его декларированные `agents`, или
     * промпты в его собственной agents директории когда он декларирует никого.
     * Ребёнок идёт первым, так что имя, которое несут оба, резолвится в
     * ребёнка.
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
   * Список всех доступных профилей (плоский, без резолва extends).
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
   * Загрузить все профили с диска. Кэшируется после первого вызова.
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
   * Резолвить цепочку extends профиля: [расширяющий, ...расширенные].
   *
   * Цикл — ошибка конфигурации и репортится как таковая. Раньше это
   * завершало прогулку голым `break`, что держало цикл конечным и никому не
   * говорило: `a extends b` и `b extends a` резолвилось в наполовину
   * собранный профиль, который потом запускался. Случай отсутствующего
   * родителя в двух строчках ниже всегда бросал — цикл та же ошибка того же
   * автора и заслуживает того же ответа.
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
   * Резолвить все схемы через цепочку extends.
   * Для каждого файла схемы найти его в цепочке и резолвить её schema-level extends.
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
   * Резолвить один файл схемы: загрузить из цепочки, смержить schema-level extends.
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
      // Схема, которую профиль декларирует и не имеет — дефект в профиле,
      // а не пустой workflow. Возврат стаба тут заставил `workflow-create`
      // репортить успех и персистить сессию с `currentStage: ''` — сессию
      // под state machine без стадий.
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
      taskControlAgents: currentSchema.taskControlAgents,
      stageAssignments: currentSchema.stageAssignments,
    };
  }

  /**
   * Загрузить схему из первого профиля в цепочке, у которого она есть.
   */
  /**
   * Одна схема со всей своей цепочкой `extends`, свёрнутой внутрь.
   *
   * Родитель раньше загружался как есть — `loadSchemaFile`, не резолвленный —
   * так что выживал только один уровень наследования. В цепочке C → B → A,
   * B держал стадии A, а C их терял: стадия, декларированная в дедушке,
   * просто исчезала. Резолвинг родителя так же, как этот резолвит ребёнка,
   * и делает цепочку цепочкой.
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
 * Имя схемы внутри профиля: имя файла без расширения.
 *
 * Профили декларируют свои схемы как имена файлов, а сессия называет одну
 * `<profileId>/<schemaId>`, и расширение там было бы шумом.
 */
export function schemaId(schemaFile: string): string {
  return schemaFile.replace(/\.ya?ml$/i, '');
}

/**
 * Квалифицировать каждую запись `allowedAgents` owning profile id.
 *
 * Схемы пишутся с голыми именами агентов, но синкаемые агенты регистрируются под
 * `<profileId>_<name>` (см. agent-names.ts). Квалификация при резолве держит
 * YAML читаемым, позволяя рантайму сравнивать с именами хоста.
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
      // Вложенные стадии — это стадии: та же квалификация применяется на любой глубине.
      ...(def.stages ? { stages: qualifyStageAgents(profileId, def.stages) } : {}),
    };
  }
  return result;
}
