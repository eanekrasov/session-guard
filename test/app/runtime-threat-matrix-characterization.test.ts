import { describe, expect, it } from 'vitest';

import {
  hasForbiddenGitSubcommand,
  isReadOnlyBashCommand,
} from '../../src/domain/session-queries.ts';

describe('runtime threat-matrix characterization', () => {
  it('treats repository selectors as the same forbidden git operation', () => {
    expect(hasForbiddenGitSubcommand('git commit -m change')).toBe(true);
    expect(hasForbiddenGitSubcommand('git -C /repo commit -m change')).toBe(true);
    expect(hasForbiddenGitSubcommand('git -C /repo status')).toBe(false);
    expect(hasForbiddenGitSubcommand('/usr/bin/git -c user.name=test push')).toBe(true);
  });

  it('keeps read-only classification conservative across relative and absolute selectors', () => {
    expect(isReadOnlyBashCommand('git status')).toBe(true);
    expect(isReadOnlyBashCommand('git -C /repo status')).toBe(true);
    expect(isReadOnlyBashCommand('git -C /repo commit -m change')).toBe(false);
    expect(isReadOnlyBashCommand('git diff --cached')).toBe(true);
    expect(isReadOnlyBashCommand('git diff --cached > report.md')).toBe(false);
  });
});
