import { describe, it, expect, vi, afterEach } from 'vitest';
import { createConsoleLogFn, noopLog } from '../../src/app/logger.ts';

describe('createConsoleLogFn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes an ISO timestamp and the message to the console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createConsoleLogFn()('info', 'hello');

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z hello$/);
  });

  it('prefixes errors and serializes extra context', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createConsoleLogFn()('error', 'boom', { code: 42 });

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('[ERROR] boom {"code":42}');
  });

  it('prefixes warnings', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createConsoleLogFn()('warn', 'careful');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('[WARN] careful');
  });
});

describe('noopLog', () => {
  it('resolves without writing anything', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await noopLog('error', 'ignored');

    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
