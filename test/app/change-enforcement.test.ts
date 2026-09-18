import { describe, expect, it } from 'vitest';

import { canonicalProjectPath, isReadOnlyBash } from '../../src/app/change-enforcement.ts';

describe('change enforcement helpers', () => {
  it('canonicalizes relative paths inside the project and rejects outside paths', () => {
    expect(canonicalProjectPath('/project', 'src/index.ts')).toBe('src/index.ts');
    expect(canonicalProjectPath('/project', '/project/src/index.ts')).toBe('src/index.ts');
    expect(canonicalProjectPath('/project', '../secrets.txt')).toBeNull();
  });

  it('classifies only safe read-only bash commands', () => {
    expect(isReadOnlyBash('git status')).toBe(true);
    expect(isReadOnlyBash('git status && git add .')).toBe(false);
  });
});
