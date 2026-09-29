import { describe, expect, it } from 'vitest';
import { errorTrace, summarizeToolArgs, summarizeToolInput } from '../../src/app/trace.ts';

describe('trace summaries', () => {
  it('redacts sensitive fields and keeps payloads bounded', () => {
    const summary = summarizeToolInput({
      tool: 'bash',
      sessionID: 'session-1',
      callID: 'call-1',
      authorization: 'Bearer secret',
      prompt: 'private prompt',
    });

    expect(summary).toEqual({
      tool: 'bash',
      sessionID: 'session-1',
      callID: 'call-1',
      authorization: '[redacted]',
      prompt: '[redacted]',
    });
  });

  it('summarizes nested values without logging their contents', () => {
    expect(summarizeToolArgs({ files: ['a', 'b'], metadata: { secret: 'value' } })).toEqual({
      files: { type: 'array', length: 2 },
      metadata: { type: 'object', keys: ['secret'] },
    });
  });

  it('normalizes unknown errors into bounded diagnostics', () => {
    expect(errorTrace(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
    expect(errorTrace('failure')).toEqual({ name: 'string', message: 'failure' });
  });

  it('does not crash on empty input', () => {
    expect(() => summarizeToolArgs({})).not.toThrow();
    expect(summarizeToolArgs({})).toEqual({});
  });

  it('handles null and undefined args gracefully', () => {
    expect(() => summarizeToolArgs(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(summarizeToolArgs(null as unknown as Record<string, unknown>)).toEqual({
      type: 'object',
    });
    expect(summarizeToolArgs(undefined as unknown as Record<string, unknown>)).toEqual({
      type: 'undefined',
    });
  });

  it('preserves safe numeric values', () => {
    expect(summarizeToolArgs({ count: 0, retries: 5 })).toEqual({ count: 0, retries: 5 });
  });

  it('summarizeToolInput redacts sensitive keys even from input', () => {
    const result = summarizeToolInput({
      credential: 'secret-key',
      token: 'abc',
      data: { secret: 'nested' },
    });
    expect(result.credential).toBe('[redacted]');
    expect(result.token).toBe('[redacted]');
    expect(result.data).toEqual({ type: 'object', keys: ['secret'] });
  });
});
