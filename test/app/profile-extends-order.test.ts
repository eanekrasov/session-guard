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
      'stages:',
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
      'stages:',
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

  it('keeps stages contributed by both profiles', async () => {
    const profile = await resolveConfig('child', profilesDir);
    const config = mergeSchemasToEngineConfig(profile.schemas);
    expect(Object.keys(config.stages ?? {}).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('a delta profile keeps what its parent declared', () => {
  it('merges stages entry by entry instead of replacing the map', async () => {
    const { SchemaLoader } = await import('../../src/schema/schema-loader.ts');
    const loader = new SchemaLoader();

    const merged = loader.mergeSchemas(
      { stages: { planning: {}, commit: {}, done: {} } },
      { stages: { planning: { loop: 'implementation' } } }
    );

    // The child touched one stage; the parent's other stages survive, and the
    // transitions that name them stay valid.
    expect(Object.keys(merged.stages ?? {}).sort()).toEqual(['commit', 'done', 'planning']);
    expect(merged.stages?.planning?.loop).toBe('implementation');
  });

  it('refines a stage instead of replacing it', async () => {
    const { SchemaLoader } = await import('../../src/schema/schema-loader.ts');
    const loader = new SchemaLoader();

    const merged = loader.mergeSchemas(
      {
        stages: {
          execution: {
            loop: 'implementation',
            stages: { code: {}, verify: { gates: ['review'] } },
            transitions: [{ from: 'code', to: 'verify' }],
          },
        },
      },
      // The child names the stage only to pin a roster.
      { stages: { execution: { stages: { code: { allowedAgents: ['coder'] } } } } }
    );

    const execution = merged.stages?.execution;
    expect(execution?.loop, 'the loop was dropped').toBe('implementation');
    expect(
      execution?.transitions?.map((t) => `${t.from}→${t.to}`),
      'the transitions were dropped'
    ).toEqual(['code→verify']);
    expect(execution?.stages?.verify?.gates, 'a sibling stage was dropped').toEqual(['review']);
    expect(execution?.stages?.code?.allowedAgents).toEqual(['coder']);
  });

  it('merges transitions by their endpoints', async () => {
    const { SchemaLoader } = await import('../../src/schema/schema-loader.ts');
    const loader = new SchemaLoader();

    const merged = loader.mergeSchemas(
      {
        transitions: [
          { from: 'a', to: 'b', guard: 'base' },
          { from: 'b', to: 'c' },
        ],
      },
      { transitions: [{ from: 'a', to: 'b', guard: 'child' }] }
    );

    expect(merged.transitions).toEqual([
      { from: 'a', to: 'b', guard: 'child' },
      { from: 'b', to: 'c' },
    ]);
  });
});
