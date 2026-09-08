import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let alpha: string;
let beta: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;
let previousHarness: string | undefined;

function makeCtx(directory: string) {
  return {
    client: {} as Record<string, unknown>,
    project: {
      id: 'test',
      name: 'test',
      directory,
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:0'),
    $: {} as Record<string, unknown>,
    experimental_workspace: {} as Record<string, unknown>,
  };
}

function seedProfile(projectDir: string, profileId: string): void {
  const dir = join(projectDir, '.opencode/profiles', profileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'profile.json'),
    JSON.stringify({ id: profileId, description: profileId, schemas: ['flow.yaml'] }),
    'utf-8'
  );
  writeFileSync(join(dir, 'flow.yaml'), 'stages:\n  planning: {}\n', 'utf-8');
}

beforeEach(() => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  previousHarness = process.env.OPENCODE_HARNESS_DIR;
  delete process.env.STATE_MACHINE_STORE_DIR;
  delete process.env.STATE_MACHINE_PROFILES_DIR;
  delete process.env.OPENCODE_HARNESS_DIR;
  alpha = mkdtempSync(join(tmpdir(), 'iso-alpha-'));
  beta = mkdtempSync(join(tmpdir(), 'iso-beta-'));
  seedProfile(alpha, 'alpha-only');
  seedProfile(beta, 'beta-only');
});

afterEach(() => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  if (previousHarness === undefined) delete process.env.OPENCODE_HARNESS_DIR;
  else process.env.OPENCODE_HARNESS_DIR = previousHarness;
  rmSync(alpha, { recursive: true, force: true });
  rmSync(beta, { recursive: true, force: true });
});

async function listProfilesThrough(hooks: Record<string, unknown>): Promise<string> {
  const tools = (await (hooks as { tool?: { register?: unknown } }).tool) as
    | Record<string, { execute: (args: unknown, ctx: unknown) => Promise<{ output: string }> }>
    | undefined;
  if (!tools?.['workflow-list']) throw new Error('workflow-list is not registered');
  const result = await tools['workflow-list'].execute({}, {});
  return result.output;
}

describe('two projects in one process', () => {
  it("does not serve the first project's profiles to the second", async () => {
    // Initialisation used to write the computed profiles directory into
    // process.env, so the second instance found it already set — with the
    // first project's path — and listed the first project's profiles.
    const { StateMachinePlugin } = await import('../../src/index.ts');

    const first = (await StateMachinePlugin(makeCtx(alpha) as never)) as Record<string, unknown>;
    const second = (await StateMachinePlugin(makeCtx(beta) as never)) as Record<string, unknown>;

    const alphaOutput = await listProfilesThrough(first);
    const betaOutput = await listProfilesThrough(second);

    expect(alphaOutput).toContain(join(alpha, '.opencode/profiles'));
    expect(alphaOutput).toContain('alpha-only');
    expect(alphaOutput).not.toContain('beta-only');

    expect(betaOutput).toContain(join(beta, '.opencode/profiles'));
    expect(betaOutput).toContain('beta-only');
    expect(betaOutput).not.toContain('alpha-only');
  });
});
