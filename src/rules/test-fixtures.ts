/**
 * Общие тестовые фикстуры, билдеры и хелперы для тестов opencode-rules.
 * Вынесены чтобы сократить дублирование и усилить типизацию в тестовых файлах.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { __testOnly } from './index.js';
import type { MatchedRulesStateStore } from './matched-rules-state.js';

// ============================================================================
// Test Directory Management
// ============================================================================

interface TestDirs {
  testDir: string;
  globalRulesDir: string;
  projectRulesDir: string;
}

let currentTestDirs: TestDirs | null = null;

export function setupTestDirs(): TestDirs {
  const testDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-rules-test-'));
  const globalRulesDir = path.join(testDir, '.config', 'opencode', 'rules');
  const projectRulesDir = path.join(testDir, 'project', '.opencode', 'rules');
  mkdirSync(globalRulesDir, { recursive: true });
  mkdirSync(projectRulesDir, { recursive: true });
  currentTestDirs = { testDir, globalRulesDir, projectRulesDir };
  return currentTestDirs;
}

export function teardownTestDirs(): void {
  if (currentTestDirs?.testDir) {
    rmSync(currentTestDirs.testDir, { recursive: true, force: true });
    currentTestDirs = null;
  }
}

export function getTestDirs(): TestDirs {
  if (!currentTestDirs) {
    throw new Error('Test dirs not initialized. Call setupTestDirs() first.');
  }
  return currentTestDirs;
}

// ============================================================================
// CI Environment Helpers
// ============================================================================

const CI_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'BUILDKITE',
  'TEAMCITY_VERSION',
] as const;

export type CiEnvSnapshot = Record<string, string | undefined>;

export function saveCiEnvVars(): CiEnvSnapshot {
  const saved: CiEnvSnapshot = {};
  for (const key of CI_ENV_VARS) {
    saved[key] = process.env[key];
  }
  return saved;
}

export function clearCiEnvVars(): void {
  for (const key of CI_ENV_VARS) {
    delete process.env[key];
  }
}

export function restoreCiEnvVars(saved: CiEnvSnapshot): void {
  for (const key of CI_ENV_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// ============================================================================
// Mock Plugin Input Helpers
// ============================================================================

interface MockPluginInput {
  testDir: string;
  toolIds?: string[];
  mcpStatus?: Record<string, { status: string }>;
  history?: Array<{ info?: unknown; parts?: unknown[] }>;
  sessionPrompt?: (args: {
    path: { id: string };
    query?: { directory?: string };
    body: {
      messageID?: string;
      noReply?: boolean;
      parts: Array<Record<string, unknown>>;
    };
  }) => Promise<unknown>;
}

/**
 * Создаёт типизированный мок-объект ввода для функции плагина.
 */
export function createMockPluginInput(opts: MockPluginInput): {
  client: {
    tool: { ids: () => Promise<{ data: string[] }> };
    mcp?: {
      status: () => Promise<{ data: Record<string, { status: string }> }>;
    };
    session: {
      messages: () => Promise<{
        data: Array<{ info?: unknown; parts?: unknown[] }>;
      }>;
    };
  };
  project: Record<string, unknown>;
  directory: string;
  worktree: string;
  $: Record<string, unknown>;
  serverUrl: URL;
} {
  const client: {
    tool: { ids: () => Promise<{ data: string[] }> };
    mcp?: {
      status: () => Promise<{ data: Record<string, { status: string }> }>;
    };
    session: {
      messages: () => Promise<{
        data: Array<{ info?: unknown; parts?: unknown[] }>;
      }>;
    };
  } = {
    tool: { ids: async () => ({ data: opts.toolIds ?? [] }) },
    session: {
      messages: async () => ({ data: opts.history ?? [] }),
      ...(opts.sessionPrompt ? { prompt: opts.sessionPrompt } : {}),
    },
  };

  if (opts.mcpStatus) {
    client.mcp = {
      status: async () => ({ data: opts.mcpStatus! }),
    };
  }

  return {
    client,
    project: {},
    directory: opts.testDir,
    worktree: opts.testDir,
    $: {},
    serverUrl: new URL('http://localhost:3000'),
  };
}

// ============================================================================
// Shared Plugin-Runtime Test Seam
// ============================================================================

/**
 * Создаёт plugin hooks с инжектед matched-rules state store так что тесты
 * никогда не трогают настоящий ~/.opencode state directory. Принимает pre-built
 * mock input так что тесты могут передать кастомный `sessionPrompt` spy.
 */
export async function createHooksWithStore(
  mockInput: ReturnType<typeof createMockPluginInput>,
  store: MatchedRulesStateStore
): ReturnType<typeof __testOnly.createHooksWithMatchedRulesStateStore> {
  return __testOnly.createHooksWithMatchedRulesStateStore(
    mockInput as unknown as Parameters<typeof __testOnly.createHooksWithMatchedRulesStateStore>[0],
    store
  );
}

export type HookChatMessage = (
  input: { sessionID: string; messageID?: string },
  output: HookChatOutput
) => Promise<void>;

export type HookChatOutput = {
  message: {
    role: string;
    id?: string;
    agent?: string;
    model?: { modelID?: string };
  };
  parts: Array<{
    id?: string;
    type?: string;
    text?: string;
    synthetic?: boolean;
    sessionID?: string;
    messageID?: string;
  }>;
};

// ============================================================================
// Generic Environment Snapshot Helpers
// ============================================================================

/**
 * Снимок переменных окружения. Использует символ-маркер чтобы отличать
 * "ключ был undefined" от "ключ не отслеживался".
 */
export type EnvSnapshot = Map<string, string | undefined>;

/**
 * Сохранить текущее значение указанных env ключей (включая undefined).
 * Возвращает снимок который можно передать в restoreEnv() для восстановления
 * исходного состояния.
 */
export function saveEnv(...keys: string[]): EnvSnapshot {
  const saved: EnvSnapshot = new Map();
  for (const key of keys) {
    // Сохранить значение даже если undefined - это критично для правильного restore
    saved.set(key, process.env[key]);
  }
  return saved;
}

/**
 * Восстановить env переменные в их снимкованное состояние.
 * Ключи, которые были undefined в снимке, удаляются из process.env.
 */
export function restoreEnv(saved: EnvSnapshot): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
