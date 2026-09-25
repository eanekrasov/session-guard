import type { PluginInput } from '@opencode-ai/plugin';
import type { Context } from '@opencode/plugin/promise/plugin';
import { createLogFn, type LogFn } from './logger.ts';
import { createReporter, type Reporter } from './report.ts';
import type { ResolveParentFn } from './session-executor.ts';
import type { SessionClient } from './runtime-types.ts';

export interface HostSessionCapabilities {
  readonly get?: SessionClient['get'];
  readonly list?: SessionClient['list'];
  readonly messages?: SessionClient['messages'];
  readonly prompt?: SessionClient['prompt'];
}

export interface HostToolCapabilities {
  readonly list?: () => Promise<readonly { readonly id: string }[]>;
}

export interface RuntimeHostAdapter {
  readonly directory: string;
  readonly project?: unknown;
  readonly session: HostSessionCapabilities;
  readonly tools: HostToolCapabilities;
  readonly log: LogFn;
  readonly report: Reporter;
  readonly resolveParent?: ResolveParentFn;
}

export interface V1RuntimeHostAdapterOptions {
  readonly client: PluginInput['client'];
  readonly directory: string;
}

export interface V2RuntimeHostAdapterOptions {
  readonly context: Context;
  readonly directory: string;
}

/**
 * Adapt the V1 SDK without exposing its request/response shapes to shared code.
 * Optional operations remain absent when the host does not provide them.
 */
export function createV1RuntimeHostAdapter(
  options: V1RuntimeHostAdapterOptions
): RuntimeHostAdapter {
  const { client } = options;
  return {
    directory: options.directory,
    session: client.session,
    tools: {
      list: async () => {
        const result = await client.tool.ids({ query: { directory: options.directory } });
        return (result.data ?? []).map((id) => ({ id }));
      },
    },
    log: createLogFn(client),
    report: createReporter(
      { post: (client as PluginInput['client'] & { post?: ReporterPost }).post },
      createLogFn(client)
    ),
  };
}

type ReporterPost = (
  path: string,
  input: { body: { message: string; variant: 'error' } }
) => Promise<unknown>;

/**
 * Adapt only V2 capabilities whose semantics are confirmed by the V2 API:
 * parent lookup through session.get and registered tool discovery through
 * tool.list. V2 app has no log/post equivalent, so those capabilities are
 * deliberately absent and use local no-op behavior.
 */
export function createV2RuntimeHostAdapter(
  options: V2RuntimeHostAdapterOptions
): RuntimeHostAdapter {
  const { context } = options;
  return {
    directory: options.directory,
    project: context.location.project,
    session: {},
    tools: {
      list: async () => (await context.tool.list()).map(({ id }) => ({ id })),
    },
    log: async () => {},
    report: () => {},
    resolveParent: async (sessionID) => {
      const session = await context.session.get({ sessionID });
      return typeof session.parentID === 'string' && session.parentID !== ''
        ? session.parentID
        : null;
    },
  };
}
