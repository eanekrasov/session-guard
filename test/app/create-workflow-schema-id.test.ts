import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginInput } from '@opencode-ai/plugin';
import { WorkflowStore } from '../../src/session/session-store.ts';
import { fixtureProfilesDir } from '../support/fixture-profiles.ts';

// `workflow.create` names the workflow a session runs as
// `<profileId>/<schemaId>`. Schema names are unique only inside their profile,
// so the qualified form is what makes the choice unambiguous; a bare id names
// the profile, and is legal only while that profile holds one schema.

let previousStoreDir: string | undefined;
let previousProfilesDir: string | undefined;
let storeDir: string;

beforeEach(() => {
  previousStoreDir = process.env.STATE_MACHINE_STORE_DIR;
  previousProfilesDir = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDir = '/tmp/create-workflow-schema-' + Math.random().toString(36).slice(2);
  process.env.STATE_MACHINE_STORE_DIR = storeDir;
  process.env.STATE_MACHINE_PROFILES_DIR = fixtureProfilesDir('profiles');
});

afterEach(() => {
  if (previousStoreDir !== undefined) process.env.STATE_MACHINE_STORE_DIR = previousStoreDir;
  else delete process.env.STATE_MACHINE_STORE_DIR;
  if (previousProfilesDir !== undefined)
    process.env.STATE_MACHINE_PROFILES_DIR = previousProfilesDir;
  else delete process.env.STATE_MACHINE_PROFILES_DIR;
});

async function create(sessionID: string, schemaId: string | undefined): Promise<string> {
  const { createRuntime } = await import('../../src/app/runtime.ts');
  const runtime = createRuntime({
    client: { app: { log: async () => {} } } as unknown as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/test',
    worktree: '/tmp/test',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  });
  const result = await runtime.tool!['workflow.create'].execute(
    { schemaId } as never,
    {
      sessionID,
      messageID: 'm1',
      agent: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    } as never
  );
  return typeof result === 'string' ? result : result.output;
}

describe('workflow.create picks one schema', () => {
  it('records the schema named as profileId/schemaId', async () => {
    const output = await create('s-qualified', 'two-schemas/beta');
    expect(output).not.toContain('error');

    const session = await new WorkflowStore(storeDir).load('s-qualified');
    expect(session?.profileId).toBe('two-schemas');
    expect(session?.schemaId).toBe('beta');
  });

  it('takes a bare id as the profile whose single schema is unambiguous', async () => {
    await create('s-bare', 'cycle-minimal');

    const session = await new WorkflowStore(storeDir).load('s-bare');
    expect(session?.profileId).toBe('cycle-minimal');
    // The file is `cycle.yaml`; the id is its name without the extension, not
    // the profile's own.
    expect(session?.schemaId).toBe('cycle');
  });

  it('refuses a bare id for a profile holding several schemas', async () => {
    const output = await create('s-ambiguous', 'two-schemas');
    expect(output).toMatch(/holds several schemas/);
    expect(output).toMatch(/alpha, beta/);

    expect(await new WorkflowStore(storeDir).load('s-ambiguous')).toBeNull();
  });

  it('lists what it has when the profile is unknown', async () => {
    const output = await create('s-unknown', 'nothing-like-this');
    expect(output).toMatch(/two-schemas\/alpha/);
    expect(output).toMatch(/two-schemas\/beta/);
  });
});
