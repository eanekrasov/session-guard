import { describe, it, expect } from 'bun:test';
import { createDebugLog, logWarning, logError } from '../../src/rules/debug.ts';

function track() {
  const calledWith: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calledWith.push(args);
  };
  return { fn, calledWith };
}

const enabled = () => true;
const disabled = () => false;

describe('createDebugLog', () => {
  it('logs when debug is enabled', () => {
    const { fn, calledWith } = track();
    createDebugLog(
      '[opencode-rules]',
      { debug: fn, warn: () => {}, error: () => {} },
      enabled
    )('test message');
    expect(calledWith).toEqual([['[opencode-rules] test message']]);
  });

  it('does not log when debug is disabled', () => {
    const { fn, calledWith } = track();
    createDebugLog(
      '[opencode-rules]',
      { debug: fn, warn: () => {}, error: () => {} },
      disabled
    )('test message');
    expect(calledWith).toEqual([]);
  });

  it('uses custom prefix', () => {
    const { fn, calledWith } = track();
    createDebugLog('[custom]', { debug: fn, warn: () => {}, error: () => {} }, enabled)('hello');
    expect(calledWith).toEqual([['[custom] hello']]);
  });

  it('does not use console.warn for debug messages', () => {
    const { fn, calledWith } = track();
    createDebugLog(
      '[opencode-rules]',
      { debug: () => {}, warn: fn, error: () => {} },
      enabled
    )('debug only message');
    expect(calledWith).toEqual([]);
  });
});

describe('logWarning', () => {
  it('logs warnings when debug is enabled', () => {
    const { fn, calledWith } = track();
    logWarning(
      'A warning',
      new Error('warning details'),
      { debug: () => {}, warn: fn, error: () => {} },
      enabled
    );
    expect(calledWith).toEqual([['[opencode-rules] Warning: A warning: warning details']]);
  });

  it('suppresses warnings when debug is disabled', () => {
    const { fn, calledWith } = track();
    logWarning(
      'A warning',
      new Error('warning details'),
      { debug: () => {}, warn: fn, error: () => {} },
      disabled
    );
    expect(calledWith).toEqual([]);
  });
});

describe('logError', () => {
  it('logs errors when debug is enabled', () => {
    const { fn, calledWith } = track();
    const err = new Error('load failed');
    logError('Failed to load rules', err, { debug: () => {}, warn: () => {}, error: fn }, enabled);
    expect(calledWith).toEqual([['[opencode-rules] Failed to load rules:', err]]);
  });

  it('suppresses errors when debug is disabled', () => {
    const { fn, calledWith } = track();
    logError(
      'Failed to load rules',
      new Error('load failed'),
      { debug: () => {}, warn: () => {}, error: fn },
      disabled
    );
    expect(calledWith).toEqual([]);
  });
});
