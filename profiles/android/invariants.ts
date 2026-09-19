/**
 * Android profile invariants.
 *
 * Адаптировано из session-guard/profiles/android/invariants.ts.
 * Отличия:
 * - Типы импортируются из src/app/invariants.ts (вместо @harness/types/invariants)
 * - Все проверки и функции идентичны оригиналу
 */

import type { InvariantCheck } from '../../src/types/index.ts';

const isKotlin = (filePath: string) => filePath.endsWith('.kt');
const isKotlinUi = (filePath: string) => filePath.endsWith('.kt') && isUiFile(filePath);

function isUiFile(filePath: string): boolean {
  return /(presentation|compose|screen|widget|view)/i.test(filePath);
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
    id: 'KOTLIN_STACK',
    severity: 'error',
    appliesTo: isKotlin,
    check: (content) => {
      if (/import\s+java\.awt\./i.test(content))
        return '[KOTLIN_STACK] Запрещённый импорт java.awt.*';
      if (/import\s+javax\.swing\./i.test(content))
        return '[KOTLIN_STACK] Запрещённый импорт javax.swing.*';
      if (/import\s+org\.springframework\./i.test(content))
        return '[KOTLIN_STACK] Запрещённый импорт org.springframework.*';
      return null;
    },
  },

  {
    id: 'NO_FQN',
    severity: 'error',
    appliesTo: isKotlin,
    check: (content) => {
      const lines = content.split('\n');
      for (const line of lines) {
        if (/^\s*import\s+/.test(line)) continue;
        if (/com\.checker\.\w+\.\w+\(/.test(line)) {
          return `[NO_FQN] Обнаружено fully qualified имя: ${line.trim().substring(0, 80)}`;
        }
      }
      return null;
    },
  },

  {
    id: 'NO_BANG_BANG',
    severity: 'error',
    appliesTo: isKotlin,
    check: (content) => {
      if (/[^"]!![^"]/.test(content) || /^!!/.test(content) || /!!$/.test(content)) {
        return '[NO_BANG_BANG] Обнаружен оператор !!. Используйте безопасный вызов (?.) или проверку на null.';
      }
      return null;
    },
  },

  {
    id: 'NO_COMMENTED_CODE',
    severity: 'error',
    appliesTo: isKotlin,
    check: (content) => {
      if (/\/\/\s*(fun\s|val\s|var\s|if\s*\(|when\s*\(|for\s*\(|while\s*\()/.test(content)) {
        return '[NO_COMMENTED_CODE] Обнаружен закомментированный код. Удалите или раскомментируйте.';
      }
      return null;
    },
  },

  {
    id: 'NAMED_ARGS',
    severity: 'warning',
    appliesTo: isKotlin,
    check: (content) => {
      const excluded = [
        'listOf(',
        'setOf(',
        'mapOf(',
        'require(',
        'check(',
        'Pair(',
        'to(',
        'replace(',
        'format(',
        'roundToInt(',
        'toString(',
        'error(',
        'TODO(',
        'Triple(',
        'arrayOf(',
        'mutableListOf(',
        'mutableSetOf(',
        'mutableMapOf(',
        'assertNotNull(',
        'assertEquals(',
        'assertTrue(',
        'assertFalse(',
      ];
      const lines = content.split('\n');
      let count = 0;
      for (const line of lines) {
        if (/^\s*(\/\/|\/\*|\*|import|package|@)/.test(line)) continue;
        if (/(fun\s+\w+|val\s+\w+|var\s+\w+)\s*=/.test(line)) continue;
        if (line.includes('=')) continue;
        const match = line.match(/(\w+)\(\s*\w+\s*,\s*\w+/);
        if (match && !excluded.some((e) => match[0].includes(e))) count++;
      }
      if (count > 0)
        return `[NAMED_ARGS] ${count} вызовов с позиционными аргументами. Рекомендуется named arguments.`;
      return null;
    },
  },

  {
    id: 'STRING_RES',
    severity: 'warning',
    appliesTo: isKotlinUi,
    check: (content) => {
      const lines = content.split('\n');
      for (const line of lines) {
        if (/^\s*(\/\/|\/\*|\*|import|package|@)/.test(line)) continue;
        if (/"[^"\n]*[а-яёА-ЯЁ][^"\n]*"/.test(line)) {
          return `[STRING_RES] Русский текст в UI-коде. Вынесите в strings.xml: ${line.trim().substring(0, 80)}`;
        }
      }
      return null;
    },
  },

  {
    id: 'RAW_COLOR',
    severity: 'warning',
    appliesTo: isKotlin,
    check: (content) => {
      if (/Color\(0x[0-9A-Fa-f]{8}\s*\)/.test(content)) {
        return '[RAW_COLOR] Обнаружен raw Color(0xFF...). Проверьте ColorPalette. Если из Figma — добавьте комментарий.';
      }
      return null;
    },
  },

  {
    id: 'RAW_DP',
    severity: 'warning',
    appliesTo: isKotlin,
    check: (content) => {
      const matches = content.match(/(?<!\w)(\d+(?:\.\d+)?)\s*\.\s*dp\b/g);
      if (matches && matches.length > 0) {
        const unique = [...new Set(matches)].slice(0, 5).join(', ');
        return `[RAW_DP] Обнаружены raw .dp: ${unique}. Проверьте Spacing/Radius.`;
      }
      return null;
    },
  },

  {
    id: 'NO_BARE_DP',
    severity: 'warning',
    appliesTo: isKotlinUi,
    check: (content) => {
      const spacingValues = new Set([2, 4, 8, 12, 16, 20, 24, 32, 48, 64, 80]);
      const radiusValues = new Set([4, 8, 12, 16, 20, 24, 32]);
      const lines = content.split('\n');
      let count = 0;
      for (const line of lines) {
        if (/^\s*(\/\/|\/\*|\*|import|package|@)/.test(line)) continue;
        if (/(Spacing\.|Radius\.|TypographyPalette\.|fontDp|0\.dp)/.test(line)) continue;
        const match = line.match(/\b(\d+)\.dp\b/);
        if (match) {
          const value = parseInt(match[1]);
          if (spacingValues.has(value) || radiusValues.has(value)) count++;
        }
      }
      if (count > 0) return `[NO_BARE_DP] ${count} .dp можно заменить на Spacing/Radius токены.`;
      return null;
    },
  },

  {
    id: 'USE_SPACER_FN',
    severity: 'warning',
    appliesTo: isKotlinUi,
    check: (content) => {
      const matches = content.match(/Spacer\(.*Modifier\.(height|width)\(Spacing\.\w+\)/g);
      if (matches && matches.length > 0) {
        return `[USE_SPACER_FN] ${matches.length} Spacer с Modifier.height/width. Используйте SpacerX().`;
      }
      return null;
    },
  },
];
