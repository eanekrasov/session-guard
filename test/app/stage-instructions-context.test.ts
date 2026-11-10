import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { SessionExecutor } from '../../src/app/session-executor.ts';
import { SessionGuardEngine } from '../../src/domain/engine.ts';

test('V2 injects the current stage on model requests without starting a session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-instructions-'));
  const profilesDir = join(root, 'profiles');
  const profile = join(profilesDir, 'example');
  const storeDir = join(root, 'store');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'profile.json'),
    JSON.stringify({ id: 'example', schemas: ['flow.yaml'] })
  );
  await writeFile(
    join(profile, 'flow.yaml'),
    'stages:\n  first:\n    instructions: First instruction\n  second:\n    instructions: Second instruction\n    loop: tasks\n    stages:\n      dev:\n        instructions: Develop\n      review:\n        instructions: Review\ntransitions:\n  - from: first\n    to: second\n'
  );
  const store = new WorkflowStore(storeDir);
  const session = createSession('root', 'example', 'flow', 'first');
  session.pendingStageContext = { stage: 'first' };
  await store.save(session);
  const calls: string[] = [];
  const runtime = createRuntime(
    {
      directory: root,
      stageInstructionsEnabled: true,
      host: {
        directory: root,
        session: {},
        tools: {},
        log: async () => {},
        report: () => {},
        resolveParent: async () => null,
      },
    },
    { storeDir, profilesDir }
  );
  const request = async (): Promise<string> => {
    calls.push('model request');
    const output = { system: [] as string[] };
    await runtime['experimental.chat.system.transform']!(
      { sessionID: 'root', model: {} } as never,
      output
    );
    return output.system.join('\n');
  };
  expect(await request()).toContain('First instruction');
  const executor = new SessionExecutor(store, undefined, undefined, true);
  await executor.run('root', async (tx) => {
    tx.session!.currentStage = 'second';
  });
  expect(calls).toEqual(['model request']);
  const next = await request();
  expect(next).toContain('Second instruction');
  expect(next).not.toContain('First instruction');
  expect(await request()).not.toContain('Second instruction');
  await executor.run('root', async (tx) => {
    tx.session!.currentStage = 'first';
  });
  await executor.run('root', async (tx) => {
    tx.session!.currentStage = 'second';
  });
  const simultaneous = await Promise.all([request(), request()]);
  expect(simultaneous.filter((text) => text.includes('Second instruction'))).toHaveLength(1);
  expect(simultaneous.every((text) => !text.includes('First instruction'))).toBe(true);

  await executor.run('root', async (tx) => {
    tx.session!.loopRuns['run-1'] = {
      id: 'run-1',
      taskId: 'task-1',
      listKey: 'tasks',
      ancestry: [],
      stage: 'dev',
      status: 'running',
      gates: {},
      round: 0,
    };
  });
  expect(await request()).toContain('Develop');
  await executor.run('root', async (tx) => {
    tx.session!.loopRuns['run-1']!.stage = 'review';
    tx.session!.loopRuns['run-1']!.round++;
  });
  expect(await request()).toContain('Review');
  expect(await request()).not.toContain('Review');

  const engine = new SessionGuardEngine({
    trackStageContext: true,
    stages: { first: {}, second: {} },
    transitions: [
      { from: 'second', to: 'first' },
      { from: 'first', to: 'second' },
    ],
  });
  await executor.run('root', async (tx) => {
    expect(engine.tryApplyTransitions(tx.session!).applied).toBe(true);
    expect(engine.tryApplyTransitions(tx.session!).applied).toBe(true);
  });
  expect(await request()).toContain('Second instruction');
  expect(await request()).not.toContain('Second instruction');

  await executor.run('root', async (tx) => {
    tx.session!.currentStage = 'first';
  });
  await store.archive('root');
  expect(await request()).toContain('First instruction');
  expect(await request()).not.toContain('First instruction');
});
