import { describe, expect, it } from 'vitest';

import { canonicalProjectPath, isReadOnlyBash } from '../../src/app/change-enforcement.ts';
import { matchesScope } from '../../src/app/scope-match.ts';
import { extractToolCallPaths } from '../../src/rules/message-paths.ts';

describe('change enforcement helpers', () => {
  it('canonicalizes relative paths inside the project and rejects outside paths', () => {
    expect(canonicalProjectPath('/project', 'src/index.ts')).toBe('src/index.ts');
    expect(canonicalProjectPath('/project', '/project/src/index.ts')).toBe('src/index.ts');
    expect(canonicalProjectPath('/project', '../secrets.txt')).toBeNull();
  });

  /**
   * Регрессия V2: хост присылает аргумент пути как `path` (V1 — `filePath`), а абсолютный путь
   * вместо относительного. До этой правки извлечение возвращало пустой список, и допуск стадии
   * отказывал в правке, которая объявлена в скоупе, словами «no entry covers this call».
   */
  it('admits a V2-shaped edit whose absolute path is inside the declared scope', () => {
    const paths = extractToolCallPaths('edit', { path: '/project/src/a.ts' }).map(
      (path) => canonicalProjectPath('/project', path) ?? path
    );

    expect(paths).toEqual(['src/a.ts']);
    expect(paths.every((path) => matchesScope(path, ['src/**']))).toBe(true);
  });

  it('classifies only safe read-only bash commands', () => {
    expect(isReadOnlyBash('git status')).toBe(true);
    expect(isReadOnlyBash('git status && git add .')).toBe(false);
  });
});
