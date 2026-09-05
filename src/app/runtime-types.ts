import type { OpencodeClient } from '@opencode-ai/sdk';

export interface PromiseChain {
  previous: Promise<void>;
  add<T>(_task: () => Promise<T>): Promise<T>;
}

/**
 * SessionClient — тип для client.session.* методов из SDK.
 * Выведен из OpencodeClient, чтобы быть синхронизированным с API.
 */
export type SessionClient = InstanceType<typeof OpencodeClient>['session'];
