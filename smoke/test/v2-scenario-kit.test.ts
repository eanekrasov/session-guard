import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runV2Scenario, type V2Scenario } from '../src/v2-scenario-kit.ts';
import { PromptTimeoutError, type V2SmokeClient } from '../src/v2-client.ts';
import type { Host } from '../src/harness.ts';

/**
 * Исполнитель V2: одна сессия на сценарий, удаление на каждом пути выхода и повтор шага
 * только пока не выполнено его ожидание относительно сохранённого состояния.
 */

const SCENARIO: V2Scenario = {
  id: 'v2-test',
  title: 'a scenario under test',
  agent: 'orchestrator',
  steps: [
    {
      instruction: 'Call the tool `workflow-create` with schemaId "smoke". Do nothing else.',
      expect: (state) =>
        state.currentStage === 'planning' || `workflow state was ${String(state.currentStage)}`,
    },
  ],
};

interface FakeHost {
  host: Host;
  /** Что плагин сохранил бы для следующего чтения. */
  setState: (state: unknown) => void;
  cleanup: () => void;
}

function makeHost(): FakeHost {
  const homeDir = mkdtempSync(join(tmpdir(), 'v2-scenarios-home-'));
  const runtime = join(homeDir, 'data', 'opencode', 'session-guard', 'runtime');
  mkdirSync(runtime, { recursive: true });
  let sessionId = 'v2-session';
  const write = (state: unknown): void => {
    writeFileSync(join(runtime, `${sessionId}.json`), JSON.stringify(state));
  };
  write({ currentStage: 'planning' });
  return {
    host: {
      homeDir,
      logs: () => '',
      stop: async () => {},
      url: 'http://127.0.0.1:0',
      workDir: homeDir,
    } satisfies Host,
    setState: write,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

function fakeClient(
  calls: string[],
  options: { onPrompt?: () => void | Promise<void> } = {}
): (host: Host) => V2SmokeClient {
  return () => ({
    async createSession(title) {
      calls.push(`create:${title}`);
      return 'v2-session';
    },
    async prompt(id, text) {
      calls.push(`prompt:${id}:${text.slice(0, 24)}`);
      await options.onPrompt?.();
    },
    async removeSession(id) {
      calls.push(`remove:${id}`);
    },
    async listMessages() {
      return [];
    },
    answeredForms: () => [],
    offScript: () => [],
  });
}

describe('runV2Scenario', () => {
  test('reads the durable state and removes the session', async () => {
    const fake = makeHost();
    const calls: string[] = [];
    try {
      const outcome = await runV2Scenario(fake.host, SCENARIO, 1, fakeClient(calls));

      expect(outcome.ok).toBe(true);
      expect(outcome.attempts).toBe(1);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe('create:v2-test');
      expect(calls[1]?.startsWith('prompt:v2-session:')).toBe(true);
      expect(calls[2]).toBe('remove:v2-session');
    } finally {
      fake.cleanup();
    }
  });

  test('retries the step while the expectation is unmet', async () => {
    const fake = makeHost();
    const calls: string[] = [];
    let prompts = 0;
    try {
      // При первом чтении шаг ещё не принимает это состояние.
      fake.setState({ currentStage: 'validation' });
      const outcome = await runV2Scenario(
        fake.host,
        SCENARIO,
        2,
        fakeClient(calls, {
          onPrompt: () => {
            prompts += 1;
            if (prompts >= 2) fake.setState({ currentStage: 'planning' });
          },
        })
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.attempts).toBe(2);
      expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(2);
    } finally {
      fake.cleanup();
    }
  });

  test('fails with the stage the state actually holds', async () => {
    const fake = makeHost();
    const calls: string[] = [];
    try {
      fake.setState({ currentStage: 'planning' });
      const outcome = await runV2Scenario(
        fake.host,
        SCENARIO,
        1,
        fakeClient(calls, { onPrompt: () => fake.setState({ currentStage: 'validation' }) })
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.evidence).toContain('workflow state was validation');
    } finally {
      fake.cleanup();
    }
  });

  test('removes the session when the prompt itself fails', async () => {
    const fake = makeHost();
    const calls: string[] = [];
    try {
      await expect(
        runV2Scenario(
          fake.host,
          SCENARIO,
          1,
          fakeClient(calls, {
            onPrompt: () => {
              throw new Error('model unavailable');
            },
          })
        )
      ).rejects.toThrow('model unavailable');
      expect(calls).toContain('remove:v2-session');
    } finally {
      fake.cleanup();
    }
  });

  test('judges a step by the persisted state when the turn outlives its budget', async () => {
    const fake = makeHost();
    const calls: string[] = [];
    try {
      const outcome = await runV2Scenario(
        fake.host,
        SCENARIO,
        3,
        fakeClient(calls, {
          onPrompt: () => {
            throw new PromptTimeoutError('session.wait', 50, 'the host had no form pending');
          },
        })
      );

      // Обращение продолжало выполняться, но состояние, запрошенное шагом, присутствует:
      // это и есть проверяемое утверждение, а прогон сообщает, что обращение ещё выполнялось.
      expect(outcome.ok).toBe(true);
      expect(outcome.attempts).toBe(1);
      expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1);
      expect(outcome.evidence).toContain('ход всё ещё выполнялся');
      expect(outcome.evidence).toContain('session.wait не завершился за 50 мс');
      expect(calls).toContain('remove:v2-session');
    } finally {
      fake.cleanup();
    }
  });

  test('fails on the state, not the budget, when the turn outlives it', async () => {
    const fake = makeHost();
    const calls: string[] = [];
    try {
      fake.setState({ currentStage: 'validation' });
      const outcome = await runV2Scenario(
        fake.host,
        SCENARIO,
        1,
        fakeClient(calls, {
          onPrompt: () => {
            throw new PromptTimeoutError('session.wait', 50, 'the host had no form pending');
          },
        })
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.evidence).toContain('workflow state was validation');
      expect(outcome.evidence).toContain('ход всё ещё выполнялся');
    } finally {
      fake.cleanup();
    }
  });
});
