import { describe, expect, test } from 'bun:test';
import { filterOperatorProviders } from '../../scripts/host-smoke/harness.ts';

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
});
