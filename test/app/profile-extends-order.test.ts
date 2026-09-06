import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig } from '../../src/public-api.ts';
import { mergeSchemasToEngineConfig } from '../../src/app/mutation-orchestrator.ts';

let profilesDir: string;

beforeEach(async () => {
  profilesDir = await mkdtemp(join(tmpdir(), 'extends-order-'));

  await mkdir(join(profilesDir, 'parent'), { recursive: true });
  await writeFile(
    join(profilesDir, 'parent', 'profile.json'),
    JSON.stringify({ id: 'parent', schemas: ['parent.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profilesDir, 'parent', 'parent.yaml'),
    [
      'phases:',
      '  a: {}',
      '  b: {}',
      'transitions:',
      '  - from: a',
      '    to: b',
      '    guard: "FROM_PARENT"',
      'actionGuards:',
      '  beginMutation: "PARENT_GUARD"',
      'requiredGates: [parentGate]',
    ].join('\n'),
    'utf-8'
  );

  await mkdir(join(profilesDir, 'child'), { recursive: true });
  await writeFile(
    join(profilesDir, 'child', 'profile.json'),
    JSON.stringify({ id: 'child', extends: 'parent', schemas: ['child.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profilesDir, 'child', 'child.yaml'),
    [
      'phases:',
      '  a: {}',
      '  b: {}',
      '  c: {}',
      'transitions:',
      '  - from: a',
      '    to: b',
      '    guard: "FROM_CHILD"',
      'actionGuards:',
      '  beginMutation: "CHILD_GUARD"',
      'requiredGates: [childGate]',
    ].join('\n'),
    'utf-8'
  );
});

afterEach(async () => {
  await rm(profilesDir, { recursive: true, force: true });
});

describe('extends resolution order', () => {
  it('resolves parent schemas before the extending profile', async () => {
    const profile = await resolveConfig('child', profilesDir);
    const sources = profile.schemas.map((schema) => schema.source);
    // The later schema wins in mergeSchemasToEngineConfig, so the extending
    // profile's own schema must come last.
    expect(sources[sources.length - 1]).toContain('child.yaml');
  });

  it('lets the extending profile override an inherited transition guard', async () => {
    const profile = await resolveConfig('child', profilesDir);
    const config = mergeSchemasToEngineConfig(profile.schemas);
    const transition = config.transitions.find((t) => t.from === 'a' && t.to === 'b');
    expect(transition?.guard).toBe('FROM_CHILD');
  });

  it('lets the extending profile override an inherited action guard', async () => {
    const profile = await resolveConfig('child', profilesDir);
    const config = mergeSchemasToEngineConfig(profile.schemas);
    expect(config.actionGuards?.beginMutation).toBe('CHILD_GUARD');
  });

  it('lets the extending profile override inherited requiredGates', async () => {
    const profile = await resolveConfig('child', profilesDir);
    const config = mergeSchemasToEngineConfig(profile.schemas);
    expect(config.requiredGates).toEqual(['childGate']);
  });

  it('keeps phases contributed by both profiles', async () => {
    const profile = await resolveConfig('child', profilesDir);
    const config = mergeSchemasToEngineConfig(profile.schemas);
    expect(Object.keys(config.phases ?? {}).sort()).toEqual(['a', 'b', 'c']);
  });
});
