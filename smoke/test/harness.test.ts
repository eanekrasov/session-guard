import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  basicAuthHeader,
  attemptsFromEnv,
  ensureOpencodeBinary,
  filterOperatorProviders,
  hostVersionFromEnv,
  legacyApiKeyFor,
  opencodeBinary,
  operatorProviders,
  readWorkflowSession,
  serverPasswordFromLogs,
  V1_BINARY,
  V2_BINARY,
  withProviderApiKey,
  writeSmokeConfigs,
} from '../src/harness.ts';

let configDirectory: string;
let savedOperatorConfig: string | undefined;

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), 'host-smoke-config-'));
  savedOperatorConfig = process.env.HOST_SMOKE_OPERATOR_CONFIG;
  process.env.HOST_SMOKE_OPERATOR_CONFIG = configDirectory;
});

afterEach(() => {
  if (savedOperatorConfig === undefined) delete process.env.HOST_SMOKE_OPERATOR_CONFIG;
  else process.env.HOST_SMOKE_OPERATOR_CONFIG = savedOperatorConfig;
  rmSync(configDirectory, { recursive: true, force: true });
});

describe('host smoke provider filtering', () => {
  test('keeps the named provider for a compound V1 model ID in both config maps', () => {
    const model = 'crpt/deepseek-ai/DeepSeek-V4-Flash-small';
    const provider = {
      crpt: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://models.example.test/v1' },
        models: { 'deepseek-ai/DeepSeek-V4-Flash-small': { name: 'DeepSeek Flash' } },
      },
      unrelated: { models: { 'other-model': {} } },
    };
    const providers = {
      unrelated: { models: { 'deepseek-ai/DeepSeek-V4-Flash-small': {} } },
      crpt: {
        ...provider.crpt,
        models: { 'DeepSeek-V4-Flash-small': { name: 'DeepSeek Flash alias' } },
      },
    };

    expect(filterOperatorProviders({ provider, providers }, model)).toEqual({
      provider: { crpt: provider.crpt },
      providers: { crpt: providers.crpt },
    });
  });

  test('loads selected provider and model from a JSONC operator config', async () => {
    writeFileSync(
      join(configDirectory, 'opencode.jsonc'),
      `{
        // Этот комментарий не должен стать частью входных данных JSON.
        "model": "acme/fast-model",
        "provider": {
          "acme": {
            "models": { "fast-model": { "name": "Fast model" } },
          },
        },
      }`
    );

    await expect(operatorProviders()).resolves.toEqual({
      model: 'acme/fast-model',
      provider: {
        acme: {
          models: { 'fast-model': { name: 'Fast model' } },
        },
      },
    });
  });

  test('does not accept malformed JSONC as an operator configuration', async () => {
    writeFileSync(
      join(configDirectory, 'opencode.jsonc'),
      '{ "model": "acme/fast-model", } broken'
    );

    await expect(operatorProviders()).resolves.toEqual({});
  });
});

describe('host version selection', () => {
  test('defaults to V1 and selects canonical binaries', () => {
    expect(hostVersionFromEnv(undefined)).toBe('v1');
    expect(opencodeBinary('v1', {})).toBe(V1_BINARY);
    expect(opencodeBinary('v2', {})).toBe(V2_BINARY);
    expect(V1_BINARY).not.toBe('/opt/homebrew/bin/opencode');
    expect(V2_BINARY).not.toBe('/opt/homebrew/bin/opencode');
  });

  test('prefers explicit binary overrides', () => {
    expect(opencodeBinary('v1', { HOST_SMOKE_V1_BINARY: '/tmp/v1' })).toBe('/tmp/v1');
    expect(opencodeBinary('v2', { HOST_SMOKE_V2_BINARY: '/tmp/v2' })).toBe('/tmp/v2');
  });

  test('reports a missing binary path and its override variable', () => {
    expect(() => ensureOpencodeBinary('v1', { HOST_SMOKE_V1_BINARY: '/missing/v1' })).toThrow(
      '/missing/v1'
    );
    expect(() => ensureOpencodeBinary('v1', { HOST_SMOKE_V1_BINARY: '/missing/v1' })).toThrow(
      'HOST_SMOKE_V1_BINARY'
    );
  });

  test('rejects unknown versions', () => {
    expect(() => hostVersionFromEnv('v3')).toThrow('ожидается «v1» или «v2»');
  });
});

describe('smoke environment and persisted state diagnostics', () => {
  test('accepts only positive integer attempt counts', () => {
    expect(attemptsFromEnv({ HOST_SMOKE_ATTEMPTS: '1' })).toBe(1);
    expect(attemptsFromEnv({ HOST_SMOKE_ATTEMPTS: '12' })).toBe(12);
    expect(attemptsFromEnv({ HOST_SMOKE_ATTEMPTS: '0' })).toBe(3);
    expect(attemptsFromEnv({ HOST_SMOKE_ATTEMPTS: '-1' })).toBe(3);
    expect(attemptsFromEnv({ HOST_SMOKE_ATTEMPTS: '1.5' })).toBe(3);
    expect(attemptsFromEnv({ HOST_SMOKE_ATTEMPTS: 'nope' })).toBe(3);
  });

  test('explains which state file is damaged', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'host-smoke-state-'));
    const file = join(homeDir, 'data/opencode/session-guard/runtime/broken.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{broken');
    try {
      await expect(readWorkflowSession({ homeDir } as never, 'broken')).rejects.toThrow(
        `[ERROR] не удалось прочитать файл сессии workflow ${file}`
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('the V2 server credential', () => {
  test('is read from the line the host prints for itself', () => {
    const logs = [
      'timestamp=... level=INFO message="listening"',
      'server password Thcv7wpFKgpv9md65rkH49XGVqEG0gcAb_3l2eYceBw',
      'timestamp=... level=INFO message="Sent HTTP response"',
    ].join('\n');

    expect(serverPasswordFromLogs(logs)).toBe('Thcv7wpFKgpv9md65rkH49XGVqEG0gcAb_3l2eYceBw');
  });

  test('is absent when the host announced none', () => {
    expect(serverPasswordFromLogs('no credential here')).toBeNull();
  });

  test('is sent as HTTP Basic with the user the host accepts', () => {
    expect(basicAuthHeader('secret')).toBe(
      `Basic ${Buffer.from('opencode:secret').toString('base64')}`
    );
  });
});

describe('host smoke configuration', () => {
  test('uses the V2 local package configuration without changing V1 loading', async () => {
    const v1 = mkdtempSync(join(tmpdir(), 'host-smoke-v1-config-'));
    const v2 = mkdtempSync(join(tmpdir(), 'host-smoke-v2-config-'));
    try {
      await writeSmokeConfigs(v1, {}, 'acme/fast-model', '/plugin/dist');
      await writeSmokeConfigs(v2, {}, 'acme/fast-model', '/plugin/dist', 'v2');

      expect(JSON.parse(readFileSync(join(v1, 'opencode.json'), 'utf-8'))).toMatchObject({
        plugin: ['file:///plugin/dist'],
      });
      expect(JSON.parse(readFileSync(join(v2, 'opencode.json'), 'utf-8'))).toMatchObject({
        plugins: [{ package: '/plugin/dist' }],
      });
    } finally {
      rmSync(v1, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  test('gives the V2 provider the key a fresh V2 data directory cannot import', async () => {
    const v1 = mkdtempSync(join(tmpdir(), 'host-smoke-v1-key-'));
    const v2 = mkdtempSync(join(tmpdir(), 'host-smoke-v2-key-'));
    const authDirectory = mkdtempSync(join(tmpdir(), 'host-smoke-auth-'));
    const auth = join(authDirectory, 'auth.json');
    writeFileSync(auth, JSON.stringify({ acme: { type: 'api', key: 'test-key' } }));
    const providers = {
      acme: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'https://example.test/v1' },
        models: { 'fast-model': {} },
      },
    };
    const read = (directory: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(directory, 'opencode.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
    try {
      await writeSmokeConfigs(v1, { providers }, 'acme/fast-model', '/plugin/dist', 'v1', auth);
      await writeSmokeConfigs(v2, { providers }, 'acme/fast-model', '/plugin/dist', 'v2', auth);

      // V1 самостоятельно читает auth.json; только V2 нужен ключ в записи провайдера.
      expect(read(v1).providers).toMatchObject({
        acme: { settings: { baseURL: 'https://example.test/v1' } },
      });
      expect(read(v2).providers).toMatchObject({
        acme: { settings: { baseURL: 'https://example.test/v1', apiKey: 'test-key' } },
      });
    } finally {
      rmSync(v1, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
      rmSync(authDirectory, { recursive: true, force: true });
    }
  });
});

describe('the legacy provider key for a V2 host', () => {
  test('is read for the selected provider only', () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-smoke-auth-'));
    const auth = join(directory, 'auth.json');
    writeFileSync(
      auth,
      JSON.stringify({ acme: { type: 'api', key: 'test-key' }, oauth: { type: 'oauth' } })
    );
    try {
      expect(legacyApiKeyFor('acme', auth)).toBe('test-key');
      expect(legacyApiKeyFor('oauth', auth)).toBeUndefined();
      expect(legacyApiKeyFor('absent', auth)).toBeUndefined();
      expect(legacyApiKeyFor('acme', join(directory, 'missing.json'))).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('never overwrites a key the operator already configured', () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-smoke-auth-'));
    const auth = join(directory, 'auth.json');
    writeFileSync(auth, JSON.stringify({ acme: { type: 'api', key: 'from-auth' } }));
    const providers = { acme: { settings: { apiKey: 'operator-key' } } };
    try {
      expect(withProviderApiKey(providers, 'acme/fast-model', auth)).toEqual(providers);
      expect(withProviderApiKey({ other: {} }, 'acme/fast-model', auth)).toEqual({ other: {} });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
