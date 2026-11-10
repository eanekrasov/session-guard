import { expect, test } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupV2Runtime } from '../../src/app/v2-plugin-adapter.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { SessionExecutor } from '../../src/app/session-executor.ts';

test('V2 context hook delivers an entered stage once without sending a prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-stage-instructions-'));
  const profile = join(root, '.opencode', 'profiles', 'example');
  const storeDir = join(root, 'store');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'profile.json'),
    JSON.stringify({ id: 'example', schemas: ['flow.yaml'] })
  );
  await writeFile(
    join(profile, 'flow.yaml'),
    'stages:\n  first: {}\n  second:\n    instructions: Check the result\ntransitions:\n  - from: first\n    to: second\n'
  );
  const store = new WorkflowStore(storeDir);
  await store.save(createSession('root', 'example', 'flow', 'first'));
  const previous = process.env.SESSION_GUARD_STORE_DIR;
  process.env.SESSION_GUARD_STORE_DIR = storeDir;
  let contextHook: ((event: never) => Promise<void>) | undefined;
  let resumed = 0;
  try {
    const dispose = await setupV2Runtime({
      location: { directory: root, project: { directory: root } },
      session: {
        get: async () => ({}),
        prompt: async () => {
          resumed++;
        },
        synthetic: async () => {
          resumed++;
        },
        hook: async (name: string, callback: (event: never) => Promise<void>) => {
          if (name === 'context') contextHook = callback;
          return { dispose: async () => {} };
        },
      },
      tool: { hook: async () => ({ dispose: async () => {} }), list: async () => [] },
    } as never);
    const executor = new SessionExecutor(store, undefined, undefined, true);
    await executor.run('root', async (tx) => {
      tx.session!.currentStage = 'second';
    });
    expect(resumed).toBe(0);
    const request = async () => {
      const event = {
        sessionID: 'root',
        model: 'provider/model',
        agent: 'build',
        options: {},
        messages: [
          { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'Continue' }] },
        ],
        system: [{ type: 'text', text: 'base' }],
      };
      await contextHook!(event as never);
      return event;
    };
    const first = await request();
    expect(first.system.map((part) => part.text).join('\n')).toContain('Check the result');
    expect(JSON.stringify(first.messages)).not.toContain('Check the result');
    const second = await request();
    expect(second.system.map((part) => part.text).join('\n')).not.toContain('Check the result');
    expect(resumed).toBe(0);
    await dispose();
  } finally {
    if (previous === undefined) delete process.env.SESSION_GUARD_STORE_DIR;
    else process.env.SESSION_GUARD_STORE_DIR = previous;
  }
});
