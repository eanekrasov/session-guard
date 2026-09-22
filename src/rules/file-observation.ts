/**
 * Нормализация файловых наблюдений.
 *
 * Один успешный файловый инструмент даёт одно File observation на файл:
 * плоский `{ path, tool, content }` record где `content` — текст вклада этого
 * файла. И `globs` и `fileContains` оценивают одну и ту же запись. Пути
 * потребляются verbatim как after-hook их получает.
 */

import type { ToolArgsMap } from '../app/tool-args.ts';

export interface FileObservation {
  path: string;
  tool: string;
  content: string;
}

/** То, что делят рантайм tool hooks и history tool parts. */
export interface RawToolEvent {
  tool: string;
  args: unknown;
  output?: string;
}

/** Сохранённый OpenCode tool part с завершённым состоянием. */
export interface HistoryToolPart {
  type?: unknown;
  tool?: unknown;
  state?: {
    status?: unknown;
    input?: unknown;
    output?: unknown;
  };
  /** Legacy AI SDK invocation shape. */
  toolInvocation?: {
    toolName?: unknown;
    args?: unknown;
  };
}

const OBSERVATION_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch', 'lsp']);

/** Только завершённые history parts — успешные события. */
function completedInput(part: HistoryToolPart): unknown {
  if (typeof part.tool !== 'string') return undefined;
  if (part.state?.status !== 'completed') return undefined;
  return part.state.input;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Return empty string for empty strings (to distinguish from missing/non-string)
  return value;
}

/**
 * Восстановить контент read: убрать wrapper теги и префиксы `{lineNumber}: `,
 * склеить возвращённые строки с newlines. Directory output не даёт
 * observation; binary, image, PDF и неузнаваемые форматы fail closed с
 * пустым контентом (путь всё ещё матчит globs).
 */
function readContent(output: string | undefined): string | null | undefined {
  if (output === undefined) return undefined;
  if (/<type>directory<\/type>/i.test(output)) return null;
  const contentMatch = /<content>([\s\S]*?)<\/content>/.exec(output);
  if (!contentMatch) {
    return '';
  }
  // Strip wrapper blank lines left by <content> tags, then the
  // `{lineNumber}: ` prefixes on returned lines.
  return contentMatch[1]
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+:\s?/, ''))
    .join('\n');
}

/**
 * Распарсить codex-style patch текст в per-file content вклады.
 * Delete File секции — path-only: их строки никогда не становятся контентом.
 * Возвращает undefined когда патч не парсится.
 */
export function parsePatch(patchText: string): FileObservation[] | undefined {
  const isPatch = patchText.includes('*** Begin Patch') || patchText.includes('*** Update File:');
  if (!isPatch) return undefined;

  const observations: FileObservation[] = [];
  let currentPath: string | undefined;
  let currentLines: string[] = [];
  let currentIsDelete = false;
  let sawStructure = false;

  const flush = (): void => {
    if (currentPath !== undefined) {
      observations.push({
        path: currentPath,
        tool: 'apply_patch',
        content: currentIsDelete ? '' : currentLines.join('\n'),
      });
    }
    currentPath = undefined;
    currentLines = [];
    currentIsDelete = false;
  };

  for (const line of patchText.split('\n')) {
    const add = /\*\*\* Add File: (.+)/.exec(line);
    const del = /\*\*\* Delete File: (.+)/.exec(line);
    const update = /\*\*\* Update File: (.+)/.exec(line);
    // Upstream эмитит `*** Move to:`; старые пиры использовали `*** Move To:`.
    const moveTo = /\*\*\* Move (?:to|To): (.+)/.exec(line);
    if (add || del || update) {
      flush();
      sawStructure = true;
      const header = add ?? del ?? update;
      currentPath = header?.[1].trim();
      currentIsDelete = del !== null;
      continue;
    }
    if (moveTo) {
      // A following Move header retargets the buffered file before its
      // hunks arrive.
      currentPath = moveTo[1].trim();
      continue;
    }
    if (currentPath === undefined) continue;
    if (line.startsWith('@@') || line.startsWith('***')) continue;
    const stripped = line.replace(/^[+-]/, '');
    currentLines.push(stripped);
  }
  flush();

  if (!sawStructure) return undefined;
  return observations;
}

function summaryPaths(output: string | undefined): FileObservation[] {
  if (!output) return [];
  const result: FileObservation[] = [];
  for (const line of output.split('\n')) {
    const move = /^R\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line);
    const simple = /^([ADM])\s+(\S+)\s*$/.exec(line);
    if (move) {
      result.push({ path: move[2], tool: 'apply_patch', content: '' });
    } else if (simple) {
      result.push({ path: simple[2], tool: 'apply_patch', content: '' });
    }
  }
  return result;
}

/** Нормализовать один live tool event в ноль или более File observations. */
export function normalizeObservations(event: RawToolEvent): FileObservation[] {
  if (!OBSERVATION_TOOLS.has(event.tool)) return [];
  if (!event.args || typeof event.args !== 'object') return [];
  const args = event.args as Record<string, unknown>;
  const path = asString(args.filePath) ?? asString(args.path);

  switch (event.tool) {
    case 'write': {
      const content = asString(args.content);
      return path ? [{ path, tool: 'write', content: content ?? '' }] : [];
    }
    case 'edit': {
      if (!path) return [];
      const oldString = asString(args.oldString);
      const newString = asString(args.newString);
      const content =
        oldString !== undefined && newString !== undefined
          ? [oldString, newString].filter((value) => value.length > 0).join('\n')
          : '';
      return [{ path, tool: 'edit', content }];
    }
    case 'apply_patch': {
      const patchText = asString(args.patchText);
      if (patchText) {
        const parsed = parsePatch(patchText);
        if (parsed) return parsed;
      }
      // A successfully applied but unparseable patch falls back to
      // path-only observations from the model-visible summary.
      return summaryPaths(event.output);
    }
    case 'read':
    case 'lsp': {
      if (!path) return [];
      // Read reconstructs the returned slice; LSP output is raw text.
      const content =
        event.tool === 'lsp' ? (asString(event.output) ?? '') : readContent(event.output);
      if (content === null) return [];
      return [
        {
          path,
          tool: event.tool,
          content: content ?? '',
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Извлечь File observations из сохранённых history tool parts. Только
 * успешно завершённые parts с строковыми именами инструментов вносят вклад.
 */
export function extractObservationsFromMessageParts(parts: readonly unknown[]): FileObservation[] {
  const result: FileObservation[] = [];
  if (!Array.isArray(parts)) return result;

  for (const value of parts) {
    if (value === null || typeof value !== 'object') continue;
    const part = value as HistoryToolPart;

    // Current shape: завершённые tool parts несущие state.input.
    if (part.type === undefined || part.type === 'tool') {
      const input = completedInput(part);
      if (input !== undefined && typeof input === 'object') {
        const toolName = typeof part.tool === 'string' ? part.tool : undefined;
        if (toolName) {
          const state = part.state as { output?: unknown } | undefined;
          const output = asString(state?.output);
          result.push(
            ...normalizeObservations({
              tool: toolName,
              args: input,
              ...(output !== undefined ? { output } : {}),
            })
          );
          continue;
        }
      }
    }

    // Legacy shape: AI SDK tool-invocation parts (нет observable output).
    if (part.type === 'tool-invocation') {
      const invocation = part.toolInvocation;
      const toolName = typeof invocation?.toolName === 'string' ? invocation.toolName : undefined;
      if (!toolName || !invocation?.args) continue;
      result.push(...normalizeObservations({ tool: toolName, args: invocation.args }));
    }
  }
  return result;
}
