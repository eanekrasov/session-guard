import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterOperatorProviders,
  hostVersionFromEnv,
  opencodeBinary,
  operatorProviders,
  V1_BINARY,
  V2_BINARY,
} from '../../scripts/host-smoke/harness.ts';

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
        // This comment must not become part of the JSON input.
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
    expect(opencodeBinary('v1')).toBe(V1_BINARY);
    expect(opencodeBinary('v2')).toBe(V2_BINARY);
    expect(V1_BINARY).not.toBe('/opt/homebrew/bin/opencode');
    expect(V2_BINARY).not.toBe('/opt/homebrew/bin/opencode');
    expect(existsSync(V1_BINARY)).toBe(true);
    expect(existsSync(V2_BINARY)).toBe(true);
  });

  test('rejects unknown versions', () => {
    expect(() => hostVersionFromEnv('v3')).toThrow('expected "v1" or "v2"');
  });
});
