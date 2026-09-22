import path from 'node:path';
import type { Message, MessagePart } from './message-paths.js';

export interface MessagePartWithSession {
  type?: string;
  text?: string;
  sessionID?: string;
  synthetic?: boolean;
  id?: string;
  callID?: string;
  tool?: string;
  state?: {
    input?: unknown;
  };
}

export interface MessageWithInfo {
  info?: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts?: MessagePartWithSession[];
}

/**
 * Извлечь и склеить текстовый контент из частей сообщения.
 * Пропускает синтетические части и части без текстового контента.
 * Возвращает пустую строку если текст не извлечён.
 */
export function extractTextFromParts(
  parts: Array<{ type?: string; text?: string; synthetic?: boolean }>
): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.synthetic) continue;

    if (part.type === 'text' && part.text) {
      textParts.push(part.text);
    } else if (typeof part.text === 'string' && !part.type) {
      textParts.push(part.text);
    }
  }

  return textParts
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Нормализовать пути в repo-relative POSIX формат.
 * Если путь абсолютный и под baseDir, конвертировать в относительный POSIX путь.
 * Иначе вернуть путь как есть.
 */
export function normalizeContextPath(filePath: string, baseDir: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(baseDir, filePath);
  return rel.split(path.sep).join('/');
}

/**
 * Убрать контрольные символы и ограничить длину для безопасного включения
 * в context строки.
 */
export function sanitizePathForContext(filePath: string): string {
  return filePath.replace(/[\r\n\t]/g, ' ').slice(0, 300);
}

/**
 * Извлечь sessionID из массива сообщений.
 */
export function extractSessionID(messages: MessageWithInfo[]): string | undefined {
  for (const message of messages) {
    if (message.info?.sessionID) {
      return message.info.sessionID;
    }
    if (message.parts) {
      for (const part of message.parts) {
        if (part.sessionID) {
          return part.sessionID;
        }
      }
    }
  }
  return undefined;
}

/**
 * Извлечь текст последнего пользовательского сообщения из массива сообщений.
 */
export function extractLatestUserPrompt(messages: MessageWithInfo[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.info?.role !== 'user') continue;
    const parts = message.parts || [];

    const userPrompt = extractTextFromParts(parts);
    if (userPrompt) {
      return userPrompt;
    }
  }

  return undefined;
}

/**
 * Конвертировать MessageWithInfo[] в Message[] фильтруя сообщения
 * не имеющие обязательных полей (role, непустой parts array).
 */
export function filterValidMessages(messages: MessageWithInfo[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const role = msg.info?.role;
    if (typeof role === 'string' && Array.isArray(msg.parts) && msg.parts.length > 0) {
      result.push({
        role,
        parts: msg.parts as MessagePart[],
      });
    }
  }
  return result;
}

/**
 * Извлечь ведущую slash command из пользовательского промпта.
 * Возвращает первый whitespace-delimited токен если он начинается с '/'
 * и содержит хотя бы один non-slash символ после ведущего слэша.
 */
export function extractSlashCommand(prompt?: string): string | undefined {
  if (!prompt) return undefined;
  const first = prompt.trim().split(/\s+/, 1)[0];
  // Must start with '/' and have at least one additional character
  if (first.length > 1 && first.startsWith('/')) {
    return first;
  }
  return undefined;
}
