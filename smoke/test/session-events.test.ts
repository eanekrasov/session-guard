import { describe, expect, test } from 'bun:test';

import { createSessionEventStream } from '../src/host/session-events.ts';

describe('session event stream', () => {
  test('routes an event to the matching waiter and keeps the stream reusable', async () => {
    const stream = createSessionEventStream<{ type: string }>();
    const first = stream.waitFor((event) => event.type === 'done');
    stream.dispatch({ type: 'ignored' });
    stream.dispatch({ type: 'done' });
    await expect(first).resolves.toEqual({ type: 'done' });

    const second = stream.waitFor((event) => event.type === 'next');
    stream.dispatch({ type: 'next' });
    await expect(second).resolves.toEqual({ type: 'next' });
  });

  test('rejects all pending waiters when the stream fails', async () => {
    const stream = createSessionEventStream<{ type: string }>();
    const waiting = stream.waitFor(() => true);
    stream.fail(new Error('[ERROR] SSE failed'));
    await expect(waiting).rejects.toThrow('SSE failed');
  });

  test('an aborted waiter does not close the shared stream', async () => {
    const stream = createSessionEventStream<{ type: string }>();
    const controller = new AbortController();
    const waiting = stream.waitFor(() => true, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('state polling exceeded its budget');

    const next = stream.waitFor(() => true);
    stream.dispatch({ type: 'still-open' });
    await expect(next).resolves.toEqual({ type: 'still-open' });
  });
});
