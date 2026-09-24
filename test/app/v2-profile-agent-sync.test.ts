import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from '@opencode/plugin/promise/plugin';
import { registerV2ProfileAgents } from '../../src/app/v2-profile-agent-sync.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

async function createProfile(agent = 'code.md', content = '# Code system') {
  const root = await mkdtemp(path.join(tmpdir(), 'v2-profile-agent-sync-'));
  temporaryDirectories.push(root);
  const profiles = path.join(root, 'profiles');
  const agentDirectory = path.join(profiles, 'base', 'agents');
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(
    path.join(profiles, 'base', 'profile.json'),
    JSON.stringify({ agents: ['code'] })
  );
  await writeFile(path.join(agentDirectory, agent), content);
  return { root, profiles };
}

function createContext(updates: string[]) {
  let disposed = false;
  const context = {
    agent: {
      transform: async (
        callback: (editor: {
          update: (id: string, update: (agent: Record<string, unknown>) => void) => void;
        }) => void
      ) => {
        callback({
          update: (id, update) => {
            const agent: Record<string, unknown> = {};
            update(agent);
            updates.push(`${id}:${JSON.stringify(agent)}`);
          },
        });
        return {
          dispose: async () => {
            disposed = true;
          },
        };
      },
    },
  } as unknown as Context;
  return { context, isDisposed: () => disposed };
}

describe('V2 profile-agent synchronization', () => {
  test('registers qualified agents and applies metadata and system text', async () => {
    const { root, profiles } = await createProfile(
      'code.md',
      '---\ndescription: Code helper\nmode: subagent\ncolor: "#123456"\n---\n\nUse the codebase.'
    );
    const updates: string[] = [];
    const { context } = createContext(updates);

    const registration = await registerV2ProfileAgents(context, root, profiles, () => {});

    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('base_code');
    expect(updates[0]).toContain('Code helper');
    expect(updates[0]).toContain('Use the codebase.');
    await registration.dispose();
  });

  test('logs sync failures and remains non-fatal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'v2-profile-agent-sync-failure-'));
    temporaryDirectories.push(root);
    const profiles = path.join(root, 'profiles');
    await mkdir(path.join(profiles, 'broken'), { recursive: true });
    await writeFile(path.join(profiles, 'broken', 'profile.json'), '{');
    const logs: string[] = [];
    const updates: string[] = [];
    const { context } = createContext(updates);

    const registration = await registerV2ProfileAgents(context, root, profiles, (message) =>
      logs.push(message)
    );

    expect(logs.some((message) => message.includes('Failed to parse'))).toBe(true);
    expect(updates).toEqual([]);
    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  test('returns a cleanup registration that disposes once', async () => {
    const { root, profiles } = await createProfile();
    const updates: string[] = [];
    const registrationState = createContext(updates);
    const registration = await registerV2ProfileAgents(
      registrationState.context,
      root,
      profiles,
      () => {}
    );

    await registration.dispose();
    await registration.dispose();

    expect(registrationState.isDisposed()).toBe(true);
  });
});
