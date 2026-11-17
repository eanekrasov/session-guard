import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createV2ContextHandler } from '../../src/app/v2-plugin-adapter.ts';
import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { SessionExecutor } from '../../src/app/session-executor.ts';
import type { V2ContextEvent } from '../../src/app/v2-plugin-contract.ts';

function createHooks(
  root: string,
  storeDir: string,
  stageInstructionsEnabled = true,
  onPrompt: () => void = () => {}
) {
  return createRuntime(
    {
      directory: root,
      stageInstructionsEnabled,
      host: {
        directory: root,
        session: {
          prompt: async () => {
            onPrompt();
          },
        },
        tools: {},
        log: async () => {},
        report: () => {},
      },
    },
    { profilesDir: join(root, '.opencode', 'profiles'), storeDir }
  );
}

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
  let promptCalls = 0;
  const hooks = createHooks(root, storeDir, true, () => promptCalls++);
  const handleContext = createV2ContextHandler(hooks.handleSystemTransform);
  try {
    const executor = new SessionExecutor(store, undefined, undefined, true);
    await executor.run('root', async (tx) => {
      tx.session!.currentStage = 'second';
    });
    expect(promptCalls).toBe(0);
    const request = async () => {
      const event: V2ContextEvent = {
        sessionID: 'root',
        model: { providerID: 'provider', id: 'model' },
        agent: 'build',
        options: {},
        messages: [
          { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'Continue' }] },
        ],
        system: [{ type: 'text', text: 'base' }],
      };
      await handleContext(event);
      return event;
    };
    const first = await request();
    expect(first.system.map((part) => part.text).join('\n')).toContain('Check the result');
    expect(JSON.stringify(first.messages)).not.toContain('Check the result');
    const second = await request();
    expect(second.system.map((part) => part.text).join('\n')).not.toContain('Check the result');
    expect(promptCalls).toBe(0);
  } finally {
    await hooks.dispose!();
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 plugin option disables stage-instruction injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-stage-instructions-disabled-'));
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
  const session = createSession('root', 'example', 'flow', 'second');
  session.pendingStageContext = { stage: 'second' };
  await store.save(session);
  const hooks = createHooks(root, storeDir, false);
  const handleContext = createV2ContextHandler(hooks.handleSystemTransform);
  try {
    const event: V2ContextEvent = {
      sessionID: 'root',
      model: { providerID: 'provider', id: 'model' },
      agent: 'build',
      options: {},
      messages: [{ id: 'message-1', role: 'user', content: [{ type: 'text', text: 'Continue' }] }],
      system: [{ type: 'text', text: 'base' }],
    };
    await handleContext(event);
    expect(event.system.map((part) => part.text).join('\n')).not.toContain('Check the result');
  } finally {
    await hooks.dispose!();
    await rm(root, { recursive: true, force: true });
  }
});
