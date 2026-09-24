import { describe, expect, test } from 'bun:test';
import { filterProviders } from '../../scripts/host-smoke/harness.ts';

describe('host smoke provider filtering', () => {
  test('keeps only the provider containing the requested fully-qualified model', () => {
    const providers = {
      wanted: { models: { 'DeepSeek-V4-Flash-small': {} } },
      unrelated: { models: { 'other-model': {} } },
    };

    expect(filterProviders(providers, 'crpt/deepseek-ai/DeepSeek-V4-Flash-small')).toEqual({
      wanted: providers.wanted,
    });
  });

  test('keeps the provider when its model key is fully qualified', () => {
    const providers = {
      wanted: { models: { 'crpt/deepseek-ai/DeepSeek-V4-Flash-small': {} } },
      unrelated: { models: { 'other-model': {} } },
    };

    expect(filterProviders(providers, 'crpt/deepseek-ai/DeepSeek-V4-Flash-small')).toEqual({
      wanted: providers.wanted,
    });
  });

  test('filters legacy provider and modern providers independently', () => {
    const providers = {
      wanted: { models: { 'DeepSeek-V4-Flash-small': {} } },
      unrelated: { models: { 'other-model': {} } },
    };

    expect(filterProviders(providers, 'DeepSeek-V4-Flash-small')).toEqual({
      wanted: providers.wanted,
    });
  });
});
