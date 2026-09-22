/**
 * Утилиты обнаружения файлов правил
 */

import { stat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDebugLog, logWarning } from './debug.js';
import { parseRuleMetadata, stripFrontmatter, type RuleMetadata } from './rule-metadata.js';

const debugLog = createDebugLog();

/**
 * Кэшированные данные правила для оптимизации производительности
 */
interface CachedRule {
  /** Raw file content */
  content: string;
  /** Parsed metadata from frontmatter */
  metadata: RuleMetadata | null;
  /** Content with frontmatter stripped */
  strippedContent: string;
  /** File modification time for cache invalidation */
  mtime: number;
}

/**
 * Кэш правил, закеированный по абсолютному пути файла
 */
const ruleCache = new Map<string, CachedRule>();

/**
 * Очистить кэш правил (полезно для тестов или ручной инвалидации)
 */
export function clearRuleCache(): void {
  ruleCache.clear();
}

/**
 * Получить кэшированные данные правила, обновляя с диска если файл изменился.
 * Использует mtime-инвалидацию для обнаружения изменений файлов.
 *
 * @param filePath - Абсолютный путь к файлу правила
 * @returns Кэшированные данные правила или null если файл не читается
 */
export async function getCachedRule(filePath: string): Promise<CachedRule | null> {
  try {
    const stats = await stat(filePath);
    const mtime = stats.mtimeMs;

    const cached = ruleCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      debugLog(`Cache hit: ${filePath}`);
      return cached;
    }

    debugLog(`Cache miss: ${filePath}`);
    const content = await readFile(filePath, 'utf-8');
    const metadata = parseRuleMetadata(content);
    const strippedContent = stripFrontmatter(content);

    const entry: CachedRule = {
      content,
      metadata,
      strippedContent,
      mtime,
    };

    ruleCache.set(filePath, entry);
    return entry;
  } catch (error) {
    // Remove stale cache entry if file no longer exists
    ruleCache.delete(filePath);
    logWarning(`Failed to read rule file ${filePath}`, error);
    return null;
  }
}

/**
 * Получить путь к глобальной директории правил
 */
function getGlobalRulesDir(): string | null {
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  if (opencodeConfigDir) {
    return path.join(opencodeConfigDir, 'rules');
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'opencode', 'rules');
  }

  const homeDir = process.env.HOME || os.homedir();
  return path.join(homeDir, '.config', 'opencode', 'rules');
}

/**
 * Рекурсивно просканировать директорию на markdown файлы правил
 * Пропускает скрытые файлы и директории (начинающиеся с .)
 * @param dir - Директория для сканирования
 * @param baseDir - Базовая директория для расчёта относительных путей
 * @returns Массив обнаруженных путей файлов с их относительными путями от baseDir
 */
async function scanDirectoryRecursively(
  dir: string,
  baseDir: string
): Promise<Array<{ filePath: string; relativePath: string }>> {
  const results: Array<{ filePath: string; relativePath: string }> = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...(await scanDirectoryRecursively(fullPath, baseDir)));
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdc')) {
        const relativePath = path.relative(baseDir, fullPath);
        results.push({ filePath: fullPath, relativePath });
      }
    }
  } catch (error) {
    // Treat ENOENT as benign (directory doesn't exist or was deleted)
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return results;
    }
    // Log non-ENOENT directory read errors
    logWarning(`Failed to read directory ${dir}`, error);
  }

  return results;
}

/**
 * Обнаруженный файл правила с абсолютным и относительным путями
 */
export interface DiscoveredRule {
  /**
   * Абсолютный путь к файлу правила
   */
  filePath: string;
  /**
   * Относительный путь от корня директории правил
   */
  relativePath: string;
}

/**
 * Неизменный per-session снимок распарсенных данных обнаруженного правила.
 * Захватывается один раз на процесс/сессию; правки файла не влияют на
 * существующий сессионный снимок.
 */
export interface RuleSnapshot extends DiscoveredRule {
  /** Короткое отображаемое имя из frontmatter или имя файла без расширения */
  name: string;
  /** Распарсенные frontmatter метаданные (null когда у файла их нет) */
  metadata: RuleMetadata | null;
  /** Контент без frontmatter */
  strippedContent: string;
}

/**
 * Загрузить снимки правил для данных обнаруженных файлов, сохраняя порядок
 * обнаружения и пропуская нечитаемые правила (предупреждения логируются
 * getCachedRule).
 */
export async function loadRuleSnapshots(files: readonly DiscoveredRule[]): Promise<RuleSnapshot[]> {
  const snapshots: RuleSnapshot[] = [];
  for (const file of files) {
    const cachedRule = await getCachedRule(file.filePath);
    if (!cachedRule) continue;
    snapshots.push({
      ...file,
      name:
        cachedRule.metadata?.name ??
        file.relativePath
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.(?:md|mdc)$/i, '') ??
        file.relativePath,
      metadata: cachedRule.metadata,
      strippedContent: cachedRule.strippedContent,
    });
  }
  return snapshots;
}

/**
 * Обнаружить markdown файлы правил из стандартных директорий
 * Ищет рекурсивно в:
 * - $OPENCODE_CONFIG_DIR/rules/ (высший приоритет)
 * - $XDG_CONFIG_HOME/opencode/rules/ (или ~/.config/opencode/rules как фоллбек)
 * - .opencode/rules/ (в директории проекта если предоставлена)
 * Находит все .md и .mdc файлы включая вложенные поддиректории.
 */
export async function discoverRuleFiles(projectDir?: string): Promise<DiscoveredRule[]> {
  const files: DiscoveredRule[] = [];

  // Discover global rules (recursively)
  const globalRulesDir = getGlobalRulesDir();
  if (globalRulesDir) {
    const globalRules = await scanDirectoryRecursively(globalRulesDir, globalRulesDir);
    for (const { filePath, relativePath } of globalRules) {
      debugLog(`Discovered global rule: ${relativePath} (${filePath})`);
      files.push({ filePath, relativePath });
    }
  }

  // Discover project-local rules (recursively) if project directory is provided
  if (projectDir) {
    const projectRulesDir = path.join(projectDir, '.opencode', 'rules');
    const projectRules = await scanDirectoryRecursively(projectRulesDir, projectRulesDir);
    for (const { filePath, relativePath } of projectRules) {
      debugLog(`Discovered project rule: ${relativePath} (${filePath})`);
      files.push({ filePath, relativePath });
    }
  }

  return files;
}
