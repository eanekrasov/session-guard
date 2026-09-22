import { parsePatch } from './file-observation.ts';

/**
 * Утилиты извлечения путей из сообщений
 */

/**
 * Типы частей сообщения из OpenCode plugin API
 */
interface ToolInvocationPart {
  type: 'tool-invocation';
  toolInvocation: {
    toolName: string;
    args: Record<string, unknown>;
  };
}

interface OpenCodeToolPart {
  type: 'tool';
  tool: string;
  state?: {
    input?: Record<string, unknown>;
  };
}

interface TextPart {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export type MessagePart = ToolInvocationPart | OpenCodeToolPart | TextPart | { type: string };

export interface Message {
  role: string;
  parts: MessagePart[];
}

/**
 * Извлечь пути к файлам из сообщений разговора для условной фильтрации правил.
 * Парсит аргументы вызовов инструментов и сканирует контент сообщений на
 * похожие на пути строки.
 *
 * @param messages - Массив сообщений разговора
 * @returns Дедуплицированный массив путей к файлам, найденных в сообщениях
 */
export function extractFilePathsFromMessages(messages: Message[]): string[] {
  const paths = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      if ((part as { synthetic?: boolean }).synthetic) continue;

      // Extract from tool invocations
      if (part.type === 'tool-invocation') {
        const toolPart = part as ToolInvocationPart;
        for (const path of extractToolCallPaths(
          toolPart.toolInvocation.toolName,
          toolPart.toolInvocation.args
        )) {
          paths.add(path);
        }
      }

      // Extract from persisted OpenCode tool parts
      if (part.type === 'tool') {
        const toolPart = part as OpenCodeToolPart;
        for (const path of extractToolCallPaths(toolPart.tool, toolPart.state?.input)) {
          paths.add(path);
        }
      }

      // Extract from text content
      if (part.type === 'text') {
        const textPart = part as TextPart;
        extractPathsFromText(textPart.text, paths);
      }
    }
  }

  return Array.from(paths);
}

/**
 * Маппинг tool-name к аргументам контекстных путей, общее для live tool execution
 * и history extraction чтобы идентичные вызовы вносили идентичные пути обоими
 * способами:
 *
 * - read / edit / write -> filePath
 * - grep -> path only (pattern/include — search terms, не пути)
 * - glob -> directory из pattern, плюс явный path
 * - bash -> workdir
 * - apply_patch -> patchText (распарсенный для путей)
 * - неизвестные инструменты -> ничего
 */
const PATH_ARG_TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
  ['read', ['filePath']],
  ['edit', ['filePath']],
  ['write', ['filePath']],
  ['glob', ['pattern', 'path']],
  ['grep', ['path']],
  ['bash', ['workdir']],
  ['apply_patch', ['patchText']],
]);

/**
 * Извлечь контекстные пути, которые вносит один вызов инструмента.
 */
export function extractToolCallPaths(toolName: string, args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];

  const argNames = PATH_ARG_TOOLS.get(toolName);
  if (!argNames) return [];

  const paths: string[] = [];
  for (const argName of argNames) {
    const value = (args as Record<string, unknown>)[argName];
    if (typeof value === 'string' && value.length > 0) {
      // For glob patterns, extract the directory part
      if (argName === 'pattern') {
        const dirPart = extractDirFromGlob(value);
        if (dirPart) paths.push(dirPart);
      }
      // For apply_patch, parse the patch text for file paths
      else if (argName === 'patchText') {
        const parsed = parsePatch(value);
        if (parsed) paths.push(...parsed.map((p) => p.path));
      } else {
        paths.push(value);
      }
    }
  }

  return paths;
}

/**
 * Извлечь путь директории из glob pattern
 */
function extractDirFromGlob(pattern: string): string | null {
  // Find the first glob character
  const globChars = ['*', '?', '[', '{'];
  let firstGlobIndex = pattern.length;

  for (const char of globChars) {
    const idx = pattern.indexOf(char);
    if (idx !== -1 && idx < firstGlobIndex) {
      firstGlobIndex = idx;
    }
  }

  if (firstGlobIndex === 0) return null;

  // Get the directory part before the glob
  const beforeGlob = pattern.substring(0, firstGlobIndex);
  const lastSlash = beforeGlob.lastIndexOf('/');

  if (lastSlash === -1) {
    // If no slash and pattern has glob characters, it's just a file prefix, not a directory
    if (firstGlobIndex < pattern.length) return null;
    return beforeGlob;
  }
  return beforeGlob.substring(0, lastSlash);
}

/**
 * Извлечь пути к файлам из текстового контента через regex
 */
function extractPathsFromText(text: string, paths: Set<string>): void {
  // Match paths that look like file paths:
  // - Start with ./, ../, /, or a word character
  // - Contain at least one /
  // - End with a file extension or directory
  const pathRegex = /(?:^|[\s"'`(])((\.{0,2}\/)?[\w./-]+\/[\w./-]+(?:\.\w+)?)/gm;

  let match;
  while ((match = pathRegex.exec(text)) !== null) {
    let potentialPath = match[1];

    // Trim trailing punctuation that likely belongs to prose, not the path
    potentialPath = potentialPath.replace(/[.,!?:;]+$/, '');

    // Filter out URLs and other non-paths
    if (
      potentialPath.includes('://') ||
      potentialPath.startsWith('http') ||
      potentialPath.includes('@')
    ) {
      continue;
    }

    // Must have a reasonable structure (not just slashes)
    if (potentialPath.replace(/[/.]/g, '').length > 0) {
      paths.add(potentialPath);
    }
  }
}
