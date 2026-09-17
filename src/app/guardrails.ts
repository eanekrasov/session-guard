export type GuardSeverity = 'block' | 'warn';

interface Guard {
  id: string;
  severity: GuardSeverity;
  patterns: RegExp[];
  custom?: (input: string) => boolean;
}

const rx = (source: string, flags = 'iu') => new RegExp(source, flags);

export const GUARDS: Guard[] = [
  {
    id: 'PROMPT_INJECTION',
    severity: 'block',
    patterns: [
      rx(
        'ignore\\s+(all\\s+)?(previous|prior|your)\\s+(instructions?|rules?|guidelines?|prompts?)'
      ),
      rx('forget\\s+(your|all|the)\\s+(rules?|instructions?|guidelines?)'),
      rx('disregard\\s+(all\\s+)?(previous|prior|your|the)\\s+(instructions?|rules?|prompts?)'),
      rx(
        "(you\\s+are\\s+now|you're\\s+now)\\s+(an?\\s+)?(unrestricted|uncensored|different|free|limitless)"
      ),
      rx('pretend\\s+(to\\s+be|you\\s+are)\\s+(an?\\s+)?(different|another|unrestricted)'),
      rx('do\\s+anything\\s+now'),
      rx('\\bDAN\\b.*(mode|prompt|jailbreak|mode\\s+enabled)'),
      rx('new\\s+(system\\s+)?(instructions?|rules?|prompt)\\s*(:\\s*|are\\s*:?)'),
      rx('игнорируй\\s+(все\\s+)?(предыдущие|свои|эти)\\s+(инструкции|правила|ограничения)'),
      rx('забудь\\s+(свои|все)\\s+(правила|инструкции|ограничения)'),
      rx(
        'пренебреги\\s+(всеми\\s+)?(предыдущими|своими|этими)\\s+(инструкциями|правилами|ограничениями)'
      ),
      rx('не\\s+следуй\\s+(своим|этим|предыдущим|моим)?\\s*(инструкциям|правилам|ограничениям)'),
      rx('теперь\\s+ты\\s+(не\\s+)?(ограничен|без\\s+ограничений|свободен|не\\s+подчиняешься)'),
      rx('ты\\s+больше\\s+не\\s+(следуешь|подчиняешься|ограничен|должен)'),
      rx('притворись\\s+(что\\s+ты|будто\\s+ты)'),
      rx('сделай\\s+вид\\s*,\\s*что\\s+ты'),
      rx('новые\\s+(инструкции|правила)\\s*:\\s*'),
    ],
  },
  {
    id: 'ROLE_OVERRIDE',
    severity: 'block',
    patterns: [
      rx('you\\s+are\\s+(a\\s+)?different\\s+(AI|agent|assistant|model|bot)'),
      rx('your\\s+role\\s+(has\\s+changed|is\\s+now|is\\s+different|has\\s+been\\s+updated)'),
      rx('act\\s+as\\s+(if\\s+you\\s+are|a\\s+different|another)\\s+(AI|agent|assistant|model)'),
      rx('your\\s+name\\s+is\\s+now'),
      rx('from\\s+now\\s+on\\s+you\\s+are\\s+(an?\\s+)?(different|new)\\s+(AI|agent|assistant)'),
      rx('ты\\s+(другой|не\\s+тот)\\s+(агент|ассистент|помощник|ИИ|бот)'),
      rx('твоя\\s+роль\\s+(изменилась|теперь|другая|поменялась)'),
      rx('действуй\\s+как\\s+(другой|не\\s+тот|новый)\\s+(агент|ассистент|помощник)'),
      rx('тебя\\s+(теперь\\s+)?зовут'),
      rx('с\\s+этого\\s+момента\\s+ты\\s+(другой|новый)\\s+(агент|ассистент|помощник)'),
    ],
  },
  {
    id: 'SYSTEM_EXTRACTION',
    severity: 'block',
    patterns: [
      rx(
        '(print|output|show|reveal|display|tell\\s+me)\\s+(me\\s+)?(your\\s+)?(system\\s+)?(prompt|instructions?|rules?)'
      ),
      rx('what\\s+(is|are)\\s+your\\s+(system\\s+)?(prompt|instructions?|rules?)'),
      rx('repeat\\s+(the\\s+)?(words?\\s+)?(above|before|starting|at\\s+the\\s+beginning)'),
      rx('output\\s+your\\s+initialization'),
      rx('dump\\s+your\\s+(system\\s+)?(prompt|instructions?|config)'),
      rx(
        '(выведи|покажи|раскрой|расскажи|напиши)\\s+(мне\\s+)?(свой|свои|твой|твои)\\s+(системн[а-яё]*\\s+)?(промпт|инструкции|правила)'
      ),
      rx('какой\\s+у\\s+тебя\\s+(системный\\s+)?(промпт|инструкции|правила)'),
      rx('повтори\\s+(слова\\s+)?(выше|в\\s+начале|предыдущие|с\\s+начала)'),
      rx('выведи\\s+(свою\\s+)?инициализацию'),
      rx('покажи\\s+(свой\\s+)?(конфиг|настройки)'),
    ],
  },
  {
    id: 'CODE_INJECTION',
    severity: 'warn',
    patterns: [
      rx('os\\.system\\s*\\('),
      rx('subprocess\\.(call|Popen|run|check_output)\\s*\\('),
      rx('\\bexec\\s*\\('),
      rx('ProcessBuilder\\s*\\('),
      rx('Runtime\\.getRuntime\\(\\)\\.exec'),
      rx('rm\\s+-rf\\s+/'),
      rx('del\\s+/[fq]\\s+[A-Za-z]:\\\\'),
      rx('format\\s+[A-Za-z]:\\s'),
      rx('dd\\s+if=/dev/'),
      rx('curl\\s+\\S+http[^\\s|]*\\s*\\|\\s*(sh|bash|python|perl|ruby)'),
      rx('wget\\s+\\S+http[^\\s|]*\\s*-O\\s*-\\s*\\|\\s*(sh|bash)'),
      rx('Invoke-WebRequest.*\\|\\s*Invoke-Expression'),
    ],
  },
  {
    id: 'CONTEXT_CONFUSION',
    severity: 'warn',
    patterns: [
      rx('очисти\\s+контекст'),
      rx('забудь\\s+вс[её]'),
      rx('сотри\\s+контекст'),
      rx('erase\\s+(context|memory)\\s+now'),
    ],
    custom: (input: string) => {
      if (typeof input !== 'string') return false;
      const spam = ['stop', 'exit', 'reset', 'очисти', 'забудь', 'сотри'].reduce((sum, word) => {
        const matches = input.match(new RegExp(`\\b${word}\\b`, 'giu')) ?? [];
        return (
          sum +
          (word === 'stop' || word === 'exit' || word === 'reset'
            ? Math.min(matches.length, 1)
            : matches.length)
        );
      }, 0);
      const emoji = (input.match(/[\p{So}\p{Sk}]/gu) ?? []).length;
      return spam >= 3 || emoji > 30;
    },
  },
  {
    id: 'INDIRECT_INJECTION',
    severity: 'warn',
    patterns: [
      rx(
        '(the\\s+)?user\\s+(said|told\\s+me|asked\\s+me|instructed)\\s+to\\s+(ignore|disregard|forget|bypass)'
      ),
      rx('admin\\s+(told|said|instructed|commanded)\\s+(me|you)\\s+to'),
      rx('developer\\s+override\\s*:'),
      rx('^SYSTEM\\s*:', 'imu'),
      rx('^INSTRUCTION\\s*:', 'imu'),
      rx('\\[SYSTEM\\s+OVERRIDE\\]'),
      rx('urgent\\s+system\\s+message\\s*:'),
      rx('пользователь\\s+сказал\\s+(игнорировать|забыть|пренебречь|не\\s+следовать)'),
      rx('админ\\s+(сказал|велел|приказал|попросил)'),
      rx('разработчик\\s+(сказал|велел)\\s*:'),
      rx('срочное\\s+системное\\s+сообщение\\s*:'),
    ],
  },
  {
    id: 'DATA_EXFILTRATION',
    severity: 'warn',
    patterns: [
      rx('cat\\s+~(/|\\\\)\\.ssh'),
      rx('read\\s+~(/|\\\\)\\.aws'),
      rx('cat\\s+~(/|\\\\)\\.git'),
      rx('cat\\s+/etc/(passwd|shadow|hosts)'),
      rx('type\\s+%USERPROFILE%'),
      rx('type\\s+%APPDATA%'),
      rx('echo\\s+\\$(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)'),
      rx('Get-ChildItem\\s+Env:'),
      rx('\\$env:(API_KEY|TOKEN|SECRET)'),
      rx('git\\s+push\\s+--force'),
      rx('git\\s+push\\s+-f\\s'),
      rx('curl\\s+-X\\s+POST.*(Bearer|token|secret|api[_-]?key)'),
      rx('curl.*-H\\s+["\']Authorization["\'].*(Bearer|Basic)'),
    ],
  },
];

export interface GuardResult {
  passed: boolean;
  blocked: string[];
  warnings: string[];
}
export interface GuardHit {
  ruleID: string;
  severity: GuardSeverity;
  source: string;
  action: 'block' | 'warn' | 'sanitize';
}

export function validateUserInput(input: string): GuardResult {
  const hits = GUARDS.filter(
    (guard) => guard.patterns.some((pattern) => pattern.test(input)) || guard.custom?.(input)
  );
  const blocked = hits.filter((hit) => hit.severity === 'block').map((hit) => hit.id);
  return {
    passed: blocked.length === 0,
    blocked,
    warnings: hits.filter((hit) => hit.severity === 'warn').map((hit) => hit.id),
  };
}

export function sanitizeToolOutput(
  input: string,
  source: string
): { output: string; hits: GuardHit[] } {
  let output = input;
  const hits: GuardHit[] = [];
  for (const guard of GUARDS) {
    let matched = false;
    for (const pattern of guard.patterns) {
      // Reset lastIndex in case a preceding .test() left it non-zero (no `g` flag, but defensive)
      pattern.lastIndex = 0;
      if (pattern.test(output)) {
        matched = true;
        if (guard.severity === 'block') {
          output = output.replace(
            new RegExp(pattern.source, pattern.flags + 'g'),
            `[BLOCKED:${guard.id}]`
          );
        }
      }
    }
    // custom guard проверяет уже санитизированный output, а не оригинальный input
    if (guard.custom?.(output)) matched = true;
    if (matched)
      hits.push({
        ruleID: guard.id,
        severity: guard.severity,
        source,
        action: guard.severity === 'block' ? 'sanitize' : 'warn',
      });
  }
  return { output, hits };
}

export function extractUserText(parts: unknown[]): string {
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const value = part as {
        type?: string;
        text?: string;
        synthetic?: boolean;
        source?: { text?: { value?: unknown } };
      };
      if (value.type === 'text' && !value.synthetic && typeof value.text === 'string')
        return [value.text];
      if (value.type === 'file') {
        const sourceText = value.source?.text?.value;
        if (typeof sourceText === 'string' && sourceText.length > 0) return [sourceText];
      }
      return [];
    })
    .join('\n');
}
