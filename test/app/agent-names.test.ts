import { describe, expect, it } from 'vitest';
import {
  agentIsAllowed,
  isQualifiedAgentName,
  qualifyAgentName,
} from '../../src/app/agent-names.ts';

describe('qualifyAgentName', () => {
  it('prefixes a bare name with the profile id', () => {
    expect(qualifyAgentName('android', 'code')).toBe('android_code');
  });

  it('leaves an already-qualified name alone', () => {
    expect(qualifyAgentName('android', 'android_code')).toBe('android_code');
  });

  it("recognises this profile's prefix", () => {
    expect(isQualifiedAgentName('android_code', 'android')).toBe(true);
    expect(isQualifiedAgentName('code', 'android')).toBe(false);
  });

  it('does not read an underscore inside an agent name as a prefix', () => {
    // `code_review` is one agent's name, not profile `code` and agent
    // `review` — the test is against the profile, not against the separator.
    expect(isQualifiedAgentName('code_review', 'android')).toBe(false);
    expect(qualifyAgentName('android', 'code_review')).toBe('android_code_review');
  });
});

describe('agentIsAllowed', () => {
  const allowed = ['code', 'debug'];

  it('accepts the bare name the schema was authored with', () => {
    expect(agentIsAllowed('code', allowed, 'android')).toBe(true);
  });

  it('accepts the qualified name the host actually reports', () => {
    // Synced agents register as `<profileId>_<name>`, so this is the form a
    // dispatch normally carries.
    expect(agentIsAllowed('android_code', allowed, 'android')).toBe(true);
  });

  it('accepts a schema authored with qualified names', () => {
    expect(agentIsAllowed('android_code', ['android_code'], 'android')).toBe(true);
    expect(agentIsAllowed('code', ['android_code'], 'android')).toBe(true);
  });

  it('rejects an agent belonging to another profile', () => {
    // Profiles stay isolated: another profile's `code` is a different agent.
    expect(agentIsAllowed('other_code', allowed, 'android')).toBe(false);
  });

  it('rejects an agent that is not listed at all', () => {
    expect(agentIsAllowed('qa', allowed, 'android')).toBe(false);
    expect(agentIsAllowed('android_qa', allowed, 'android')).toBe(false);
  });

  it('allows anything when the list is empty', () => {
    expect(agentIsAllowed('whatever', [], 'android')).toBe(true);
  });
});
