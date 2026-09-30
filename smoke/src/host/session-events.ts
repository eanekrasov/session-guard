export interface SessionEventStream<TEvent> {
  waitFor(predicate: (event: TEvent) => boolean, signal?: AbortSignal): Promise<TEvent>;
  dispatch(event: TEvent): void;
  fail(error: Error): void;
  close(): void;
}

interface Waiter<TEvent> {
  predicate: (event: TEvent) => boolean;
  resolve: (event: TEvent) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
}

const CLOSED_ERROR = new Error('[ERROR] session SSE stream is closed');

export function createSessionEventStream<TEvent>(): SessionEventStream<TEvent> {
  const waiters: Array<Waiter<TEvent>> = [];
  let terminalError: Error | undefined;

  const remove = (waiter: Waiter<TEvent>): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    waiter.signal?.removeEventListener('abort', waiter.abort);
  };

  const rejectAll = (error: Error): void => {
    for (const waiter of [...waiters]) {
      remove(waiter);
      waiter.reject(error);
    }
  };

  return {
    waitFor(predicate, signal): Promise<TEvent> {
      if (terminalError !== undefined) return Promise.reject(terminalError);
      if (signal?.aborted) {
        return Promise.reject(new Error('[ERROR] state polling exceeded its budget'));
      }

      return new Promise<TEvent>((resolve, reject) => {
        const waiter: Waiter<TEvent> = {
          predicate,
          resolve: (event) => {
            remove(waiter);
            resolve(event);
          },
          reject: (error) => {
            remove(waiter);
            reject(error);
          },
          signal,
          abort: () => {
            remove(waiter);
            reject(new Error('[ERROR] state polling exceeded its budget'));
          },
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', waiter.abort, { once: true });
      });
    },

    dispatch(event): void {
      if (terminalError !== undefined) return;
      const waiter = waiters.find((candidate) => candidate.predicate(event));
      waiter?.resolve(event);
    },

    fail(error): void {
      if (terminalError !== undefined) return;
      terminalError = error;
      rejectAll(error);
    },

    close(): void {
      if (terminalError !== undefined) return;
      terminalError = CLOSED_ERROR;
      rejectAll(CLOSED_ERROR);
    },
  };
}
