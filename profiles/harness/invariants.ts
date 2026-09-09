/**
 * Harness profile invariants.
 *
 * Адаптировано из session-guard/profiles/harness/invariants.ts.
 * Отличия:
 * - Типы импортируются из src/app/invariants.ts (вместо @harness/types/invariants)
 * - Все проверки и функции идентичны оригиналу
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { InvariantCheck } from '../../src/app/invariants.ts';

const isTypeScript = (filePath: string) => filePath.endsWith('.ts');
const LOCK_FILES = new Set(['package-lock.json', 'bun.lock', 'bun.lockb']);

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const n = content.length;
  let i = 0;

  const readQuoted = (start: number): string => {
    const quote = content[start];
    let j = start + 1;
    let out = '';
    while (j < n) {
      const c = content[j];
      if (c === '\\') {
        out += c + (content[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (c === quote) break;
      out += c;
      j++;
    }
    return out;
  };

  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < n) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === ch) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(content[j])) j++;
      const word = content.slice(i, j);
      if (word === 'import') {
        let k = j;
        while (k < n && /\s/.test(content[k])) k++;
        if (content[k] === '(') {
          let p = k + 1;
          while (p < n && /\s/.test(content[p])) p++;
          if (content[p] === '"' || content[p] === "'") specifiers.push(readQuoted(p));
        } else if (content[k] === '"' || content[k] === "'") {
          specifiers.push(readQuoted(k));
        } else {
          const lineEnd = content.indexOf('\n', j);
          const end = lineEnd === -1 ? n : lineEnd;
          const from = /\bfrom\s*(["'])/.exec(content.slice(j, end));
          if (from) specifiers.push(readQuoted(j + from.index + from[0].length - 1));
        }
      } else if (word === 'from') {
        let p = j;
        while (p < n && /\s/.test(content[p])) p++;
        if (content[p] === '"' || content[p] === "'") specifiers.push(readQuoted(p));
      }
      i = j;
      continue;
    }
    i++;
  }
  return specifiers;
}

function resolveRelativeImport(importerDir: string, specifier: string): boolean {
  const candidates = [
    specifier,
    `${specifier}.ts`,
    `${specifier}.tsx`,
    `${specifier}.js`,
    `${specifier}.json`,
    `${specifier}/index.ts`,
    `${specifier}/index.tsx`,
    `${specifier}/index.json`,
  ];
  return candidates.some((candidate) => existsSync(resolve(importerDir, candidate)));
}

const ANGLICISM_WORDS = ['non-RF', 'auth', 'back', 'button', 'login', 'logout', 'signup', 'signin'];
const ANGLICISM_RE = new RegExp(`\\b(?:${ANGLICISM_WORDS.join('|')})\\b`, 'iu');

function findAnglicism(text: string): string | null {
  if (!/[а-яё]/iu.test(text)) return null;
  return ANGLICISM_RE.exec(text)?.[0] ?? null;
}

function extractTsTextSegments(line: string): string[] {
  const segments: string[] = [];
  const lineComment = line.match(/\/\/([^\n]*)$/u);
  if (lineComment) segments.push(lineComment[1]!);
  for (const block of line.matchAll(/\/\*([^*]|\*[^/])*\*\//gu)) segments.push(block[1]!);
  for (const str of line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gu)) segments.push(str[2]!);
  return segments;
}

export const INVARIANTS: InvariantCheck[] = [
  {
    id: 'LF_ONLY',
    severity: 'error',
    check: (content) => {
      if (content.includes('\r\n')) {
        return '[LF_ONLY] Обнаружены CRLF-окончания строк. Используйте только LF (\\n).';
      }
      return null;
    },
  },

  {
    id: 'BROKEN_IMPORT',
    severity: 'error',
    appliesTo: isTypeScript,
    check: (content, _filePath, absolutePath) => {
      const importerDir = dirname(absolutePath);
      for (const specifier of extractImportSpecifiers(content)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        if (!resolveRelativeImport(importerDir, specifier)) {
          const line = content.split('\n').find((line) => line.includes(specifier)) ?? '';
          return `[BROKEN_IMPORT] Нерезолвимый относительный импорт "${specifier}": ${line.trim().substring(0, 80)}`;
        }
      }
      return null;
    },
  },

  {
    id: 'CONSOLE_LOG',
    severity: 'warning',
    appliesTo: (filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.test.ts'),
    check: (content) => {
      const lines = content.split('\n');
      for (const line of lines) {
        if (/console\.log\s*\(/.test(line)) {
          return `[CONSOLE_LOG] console.log в production-коде: ${line.trim().substring(0, 80)}`;
        }
      }
      return null;
    },
  },

  {
    id: 'INVALID_JSON',
    severity: 'error',
    appliesTo: (filePath) =>
      filePath.endsWith('.json') && !LOCK_FILES.has(filePath.split('/').pop() ?? ''),
    check: (content) => {
      try {
        JSON.parse(content);
        return null;
      } catch (error) {
        return `[INVALID_JSON] Некорректный JSON: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  },

  {
    id: 'ANGLICISM',
    severity: 'warning',
    appliesTo: (filePath) => filePath.endsWith('.md') || filePath.endsWith('.ts'),
    check: (content, filePath) => {
      const isMarkdown = filePath.endsWith('.md');
      const lines = content.split('\n');
      let inFence = false;
      for (const line of lines) {
        if (isMarkdown) {
          const trimmed = line.trimStart();
          if (/^(```|~~~)/u.test(trimmed)) {
            inFence = !inFence;
            continue;
          }
          if (inFence) continue;
          const word = findAnglicism(line);
          if (word)
            return `[ANGLICISM] Англицизм "${word}" в русском тексте: ${line.trim().substring(0, 80)}`;
        } else {
          for (const segment of extractTsTextSegments(line)) {
            const word = findAnglicism(segment);
            if (word)
              return `[ANGLICISM] Англицизм "${word}" в русском тексте: ${line.trim().substring(0, 80)}`;
          }
        }
      }
      return null;
    },
  },
];
