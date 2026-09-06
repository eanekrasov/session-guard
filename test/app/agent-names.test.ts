import { describe, expect, it } from 'vitest';
import {
  agentIsAllowed,
  isQualifiedAgentName,
  qualifyAgentName,
} from '../../src/app/agent-names.ts';

describe('qualifyAgentName', () => {
  it('prefixes a bare name with the profile id', () => {
    expect(qualifyAgentName('android', 'code')).toBe('android/code');
  });

  it('leaves an already-qualified name alone', () => {
    expect(qualifyAgentName('android', 'android/code')).toBe('android/code');
    expect(qualifyAgentName('android', 'other/code')).toBe('other/code');
  });

  it('recognises qualified names', () => {
    expect(isQualifiedAgentName('android/code')).toBe(true);
    expect(isQualifiedAgentName('code')).toBe(false);
  });
});

describe('agentIsAllowed', () => {
  const allowed = ['code', 'debug'];

  it('accepts the bare name the schema was authored with', () => {
    expect(agentIsAllowed('code', allowed, 'android')).toBe(true);
  });

  it('accepts the qualified name the host actually reports', () => {
    // Synced agents register as `<profileId>/<name>`, so this is the form a
    // dispatch normally carries.
    expect(agentIsAllowed('android/code', allowed, 'android')).toBe(true);
  });

  it('accepts a schema authored with qualified names', () => {
    expect(agentIsAllowed('android/code', ['android/code'], 'android')).toBe(true);
    expect(agentIsAllowed('code', ['android/code'], 'android')).toBe(true);
  });

  it('rejects an agent belonging to another profile', () => {
    // Profiles stay isolated: another profile's `code` is a different agent.
    expect(agentIsAllowed('other/code', allowed, 'android')).toBe(false);
  });

  it('rejects an agent that is not listed at all', () => {
    expect(agentIsAllowed('qa', allowed, 'android')).toBe(false);
    expect(agentIsAllowed('android/qa', allowed, 'android')).toBe(false);
  });

  it('allows anything when the list is empty', () => {
    expect(agentIsAllowed('whatever', [], 'android')).toBe(true);
  });
});
