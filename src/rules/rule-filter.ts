/**
 * Утилиты матчинга правил и классификации lifetime
 */

import { minimatch } from 'minimatch';
import { createDebugLog } from './debug.js';
import type { RuleSnapshot } from './rule-discovery.js';
import { hasConditions } from './rule-metadata.js';
import type { RuleMetadata } from './rule-metadata.js';
import type { FileObservation } from './file-observation.js';

const debugLog = createDebugLog();

/**
 * Delivery lifetime сматченного правила. Durable правила персистятся как
 * синтетические части в истории сессии; ephemeral правила доставляются только
 * как request-scoped transient сообщения.
 */
export type RuleLifetime = 'durable' | 'ephemeral';

/** Измерения условий, которые может декларировать правило. */
export type RuleConditionKind =
  | 'globs'
  | 'fileContains'
  | 'keywords'
  | 'tools'
  | 'model'
  | 'agent'
  | 'command'
  | 'project'
  | 'branch'
  | 'os'
  | 'ci';

/** Result of evaluating a single declared condition. */
export interface ConditionEvaluation {
  kind: RuleConditionKind;
  matched: boolean;
  lifetime: RuleLifetime;
}

/** Session-durable condition kinds (everything except agent/model/branch/tools). */
const DURABLE_KINDS: ReadonlySet<RuleConditionKind> = new Set([
  'globs',
  'fileContains',
  'keywords',
  'command',
  'project',
  'os',
  'ci',
]);

function lifetimeForKind(kind: RuleConditionKind): RuleLifetime {
  return DURABLE_KINDS.has(kind) ? 'durable' : 'ephemeral';
}

/**
 * Классифицировать delivery lifetime сматченного правила из его
 * результатов условий. Безусловные правила — durable. `match: all` —
 * ephemeral когда любой required condition — ephemeral; `match: any` —
 * durable когда хотя бы один удовлетворённый condition — durable.
 */
export function classifyRuleLifetime(
  mode: 'any' | 'all',
  results: readonly ConditionEvaluation[]
): RuleLifetime {
  if (results.length === 0) return 'durable';
  if (mode === 'all') {
    return results.some((result) => result.lifetime === 'ephemeral') ? 'ephemeral' : 'durable';
  }
  return results.some((result) => result.matched && result.lifetime === 'durable')
    ? 'durable'
    : 'ephemeral';
}

/**
 * Проверить, матчит ли путь файла любое из данных glob patterns
 */
function fileMatchesGlobs(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => minimatch(filePath, glob, { matchBase: true }));
}

/**
 * Проверить, содержит ли контент наблюдения любые из данных case-sensitive
 * литеральных подстрок.
 */
function contentMatchesLiterals(content: string, literals: string[]): boolean {
  return literals.some((literal) => content.includes(literal));
}

/**
 * Проверить, матчит ли пользовательский промпт любое из данных ключевых слов.
 * Использует case-insensitive word-boundary матчинг.
 *
 * @param prompt - Текст промпта пользователя
 * @param keywords - Массив ключевых слов для матчинга
 * @returns true если любое ключевое слово матчит промпт
 */
export function promptMatchesKeywords(prompt: string, keywords: string[]): boolean {
  const lowerPrompt = prompt.toLowerCase();

  return keywords.some((keyword) => {
    const lowerKeyword = keyword.toLowerCase();
    // Escape special regex characters in the keyword
    const escaped = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word boundary at start, but allow continuation at end (e.g., "test" matches "testing")
    const regex = new RegExp(`\\b${escaped}`, 'i');
    return regex.test(lowerPrompt);
  });
}

/** Проверить, есть ли любой required tool в available set. */
export function toolsMatchAvailable(availableToolIDs: string[], requiredTools: string[]): boolean {
  const availableSet = new Set(availableToolIDs);
  return requiredTools.some((tool) => availableSet.has(tool));
}

/** True когда правило декларирует любое file-observation-family условие
 * (`globs`, `fileContains`, или оба). Общее для live matching и
 * runtime observation-time admission filter. */
export function hasFileObservationFamily(metadata: RuleMetadata | null | undefined): boolean {
  return metadata?.globs !== undefined || metadata?.fileContains !== undefined;
}

/**
 * Оценить file-observation family: `globs` и `fileContains` над одним
 * observation. С обоими декларированными, одно observation должно удовлетворять
 * свой path pattern И содержать литерал. `globs` в одиночку сохраняет legacy
 * поведение по observation set. `fileContains` без `globs` матчит только
 * контент. Декларированный но пустой `fileContains` fails closed: правило
 * никогда не матчит и одно предупреждение логируется.
 */
function evaluateFileObservationFamily(
  metadata: RuleMetadata,
  context: RuleMatchContext
): ConditionEvaluation | undefined {
  if (!hasFileObservationFamily(metadata)) return undefined;
  const { globs, fileContains } = metadata;

  const failClosed = fileContains !== undefined && fileContains.length === 0;
  // The parse-time warning in rule-metadata covers the failure; here it only
  // fails closed, silently.

  const matchable = failClosed
    ? undefined
    : (context.fileObservations ?? []).find(
        (observation) =>
          (!globs || fileMatchesGlobs(observation.path, globs)) &&
          (fileContains === undefined || contentMatchesLiterals(observation.content, fileContains))
      );

  if (fileContains !== undefined) {
    return {
      kind: 'fileContains',
      matched: Boolean(matchable),
      lifetime: lifetimeForKind('fileContains'),
    };
  }
  return {
    kind: 'globs',
    matched: Boolean(matchable),
    lifetime: lifetimeForKind('globs'),
  };
}

/**
 * Оценить все декларированные condition checks для правила против runtime context.
 * Возвращает одну оценку на декларированное условие с его kind и lifetime.
 */
function evaluateConditionChecks(
  metadata: RuleMetadata,
  context: RuleMatchContext,
  availableToolSet?: Set<string>
): ConditionEvaluation[] {
  const checks: ConditionEvaluation[] = [];

  const familyCheck = evaluateFileObservationFamily(metadata, context);
  if (familyCheck) {
    checks.push(familyCheck);
  }

  if (metadata.keywords) {
    checks.push({
      kind: 'keywords',
      matched: Boolean(
        context.userPrompt && promptMatchesKeywords(context.userPrompt, metadata.keywords)
      ),
      lifetime: lifetimeForKind('keywords'),
    });
  }

  if (metadata.tools) {
    checks.push({
      kind: 'tools',
      matched: Boolean(
        availableToolSet && metadata.tools.some((tool) => availableToolSet.has(tool))
      ),
      lifetime: lifetimeForKind('tools'),
    });
  }

  if (metadata.model) {
    checks.push({
      kind: 'model',
      matched: Boolean(context.modelID && metadata.model.includes(context.modelID)),
      lifetime: lifetimeForKind('model'),
    });
  }

  if (metadata.agent) {
    checks.push({
      kind: 'agent',
      matched: Boolean(context.agentType && metadata.agent.includes(context.agentType)),
      lifetime: lifetimeForKind('agent'),
    });
  }

  if (metadata.command) {
    checks.push({
      kind: 'command',
      matched: Boolean(context.command && metadata.command.includes(context.command)),
      lifetime: lifetimeForKind('command'),
    });
  }

  if (metadata.project) {
    const projectTags = context.projectTags;
    checks.push({
      kind: 'project',
      matched: Boolean(
        projectTags &&
        projectTags.length > 0 &&
        metadata.project.some((tag) => projectTags.includes(tag))
      ),
      lifetime: lifetimeForKind('project'),
    });
  }

  if (metadata.branch) {
    const gitBranch = context.gitBranch;
    checks.push({
      kind: 'branch',
      matched: Boolean(
        gitBranch &&
        metadata.branch.some((pattern) => {
          if (pattern === gitBranch) return true;
          const hasGlobChars = /[*?\[{]/.test(pattern);
          if (hasGlobChars) {
            return minimatch(gitBranch, pattern);
          }
          return false;
        })
      ),
      lifetime: lifetimeForKind('branch'),
    });
  }

  if (metadata.os) {
    checks.push({
      kind: 'os',
      matched: Boolean(context.os && metadata.os.includes(context.os)),
      lifetime: lifetimeForKind('os'),
    });
  }

  if (metadata.ci !== undefined) {
    checks.push({
      kind: 'ci',
      matched: context.ci === metadata.ci,
      lifetime: lifetimeForKind('ci'),
    });
  }

  return checks;
}

/**
 * Runtime match context для условного rule matching
 */
export interface RuleMatchContext {
  /** Нормализованные файловые наблюдения (для glob и fileContains матчинга) */
  fileObservations?: FileObservation[];
  /** Текст промпта пользователя (для keyword матчинга) */
  userPrompt?: string;
  /** Доступные tool IDs (для tool-based матчинга) */
  availableToolIDs?: string[];
  /** Текущий model ID */
  modelID?: string;
  /** Текущий agent type */
  agentType?: string;
  /** Текущая slash command (например /plan, /review) */
  command?: string;
  /** Обнаруженные project теги (например node, python, monorepo) */
  projectTags?: string[];
  /** Текущее имя git branch */
  gitBranch?: string;
  /** Текущая операционная система (например linux, darwin, win32) */
  os?: string;
  /** Работает ли в CI окружении */
  ci?: boolean;
}

/**
 * Один файл правила, который сматчился runtime context
 */
export interface MatchedRuleEntry {
  /** Абсолютный путь к файлу правила */
  filePath: string;
  /** Относительный путь от корня директории правил */
  relativePath: string;
  /** Короткое отображаемое имя из frontmatter или имя файла без расширения */
  name: string;
  /** Контент правила без frontmatter */
  strippedContent: string;
  /** Per-condition evaluation results с delivery-lifetime provenance */
  conditionResults: ConditionEvaluation[];
  /** Delivery lifetime классификация для этой оценки */
  lifetime: RuleLifetime;
}

/**
 * Заматчить уже загруженные rule snapshots против runtime context.
 * Не выполняет filesystem I/O: вызывающие загружают snapshots первыми (live
 * delivery использует loadRuleSnapshots, который mtime-кэшируется на сессию).
 * Безусловные правила всегда включены; условные правила включены когда их
 * декларированные checks проходят (match: any|all). Порядок записей следует
 * порядку snapshot.
 *
 * @param snapshots - Rule snapshots загруженные вызывающим
 * @param context - Опциональный RuleMatchContext для условного rule matching
 */
export function matchRuleSnapshots(
  snapshots: readonly RuleSnapshot[],
  context: RuleMatchContext = {}
): MatchedRuleEntry[] {
  if (snapshots.length === 0) {
    return [];
  }

  const availableToolSet =
    context.availableToolIDs && context.availableToolIDs.length > 0
      ? new Set(context.availableToolIDs)
      : undefined;

  const matched: MatchedRuleEntry[] = [];

  for (const { filePath, relativePath, name, metadata, strippedContent } of snapshots) {
    const ruleHasConditions = hasConditions(metadata);

    if (ruleHasConditions && metadata) {
      const declaredChecks = evaluateConditionChecks(metadata, context, availableToolSet);

      const mode = metadata.match ?? 'any';
      const shouldInclude =
        mode === 'all'
          ? declaredChecks.every((check) => check.matched)
          : declaredChecks.some((check) => check.matched);

      if (!shouldInclude) {
        debugLog(
          `Skipping conditional rule: ${relativePath} (match: ${mode}, checks: ${declaredChecks
            .map((check) => `${check.kind}=${check.matched}`)
            .join(', ')})`
        );
        continue;
      }

      debugLog(
        `Including conditional rule: ${relativePath} (match: ${mode}, checks: ${declaredChecks
          .map((check) => `${check.kind}=${check.matched}`)
          .join(', ')})`
      );

      matched.push({
        filePath,
        relativePath,
        name,
        strippedContent,
        conditionResults: declaredChecks,
        lifetime: classifyRuleLifetime(mode, declaredChecks),
      });
    } else {
      matched.push({
        filePath,
        relativePath,
        name,
        strippedContent,
        conditionResults: [],
        lifetime: 'durable',
      });
    }
  }

  return matched;
}
