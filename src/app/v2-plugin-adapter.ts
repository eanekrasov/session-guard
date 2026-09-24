import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import { Effect } from 'effect';
import { Tool } from '@opencode/schema/tool';
import { mkdirSync } from 'node:fs';
import { opencodeStateDir, profilesDir, sessionsDir } from './paths.ts';
import { createRuntime, type RuntimeContext } from './runtime.ts';
import { formatWorkflowList } from './workflow-tool-surface.ts';
import { listProfiles } from '../public-api.ts';
import {
  v2ProjectDirectory,
  v2ParentResolver,
  v2ToolAfterEvent,
  v2ToolBeforeEvent,
  v2WorktreeDirectory,
} from './v2-plugin-contract.ts';

export interface V2SetupResult {
  readonly cleanup: () => Promise<void>;
  readonly registration: Registration;
}

function ensureDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // Runtime operations report actionable failures when a directory is unavailable.
  }
}

export async function setupV2Runtime(context: Context): Promise<() => Promise<void>> {
  const projectDirectory = v2ProjectDirectory(context);
  const worktreeDirectory = v2WorktreeDirectory(context);
  // V2 instances must derive project-local profiles independently. Reading the
  // process-wide V1 override here would let another plugin instance redirect
  // this adapter while tests or hosts initialize projects concurrently.
  const profileDirectory = profilesDir(projectDirectory, false);
  const sessionStoreDirectory = sessionsDir(opencodeStateDir());

  ensureDirectory(profileDirectory);
  ensureDirectory(sessionStoreDirectory);

  const runtimeContext: RuntimeContext = {
    client: {},
    directory: worktreeDirectory,
    resolveParent: v2ParentResolver(context.session),
  };
  const hooks = createRuntime(runtimeContext, {
    profilesDir: profileDirectory,
    storeDir: sessionStoreDirectory,
  });
  const before = hooks['tool.execute.before'] as (
    input: {
      tool: string;
      sessionID: string;
      callID: string;
      agent?: string;
      messageID?: string;
    },
    output: { args: unknown }
  ) => Promise<void>;
  const after = hooks['tool.execute.after'] as (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => Promise<void>;
  const registrations: Registration[] = [];
  try {
    const beforeRegistration = await context.tool.hook('execute.before', async (event) => {
      const mapped = v2ToolBeforeEvent(event);
      await before(
        {
          tool: mapped.tool,
          sessionID: mapped.sessionID,
          callID: mapped.callID,
          agent: mapped.agent,
          messageID: mapped.messageID,
        },
        { args: mapped.input }
      );
    });
    registrations.push(beforeRegistration);
    const afterRegistration = await context.tool.hook('execute.after', async (event) => {
      const mapped = v2ToolAfterEvent(event);
      if (mapped.status === 'error') {
        await hooks.handleToolFailure({ sessionID: mapped.sessionID, callID: mapped.callID });
        return;
      }
      await after(
        {
          tool: mapped.tool,
          sessionID: mapped.sessionID,
          callID: mapped.callID,
          args: mapped.input,
        },
        {
          title: mapped.tool,
          output: typeof mapped.result.output === 'string' ? mapped.result.output : '',
          metadata: mapped.result.metadata,
        }
      );
    });
    registrations.push(afterRegistration);
    const transform = context.tool.transform;
    if (typeof transform === 'function') {
      const workflowListRegistration = await transform((editor) => {
        editor.add({
          name: 'workflow-list',
          description:
            'List all available workflow profiles (schemas). Returns profilesDir and profile IDs with descriptions.',
          input: { type: 'object', properties: {}, additionalProperties: false },
          execute: () =>
            Effect.runPromise(
              Effect.tryPromise({
                try: async () => ({
                  output: formatWorkflowList(
                    profileDirectory,
                    await listProfiles(profileDirectory)
                  ),
                }),
                catch: (error) =>
                  new Tool.Error({
                    message: `[ERROR] workflow-list failed for ${profileDirectory}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  }),
              })
            ),
        });
      });
      registrations.push(workflowListRegistration);
    }
  } catch (error) {
    await Promise.allSettled(registrations.map((registration) => registration.dispose()));
    await hooks.dispose!().catch(() => {});
    throw error;
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    let disposalError: unknown;
    for (const registration of [...registrations].reverse()) {
      try {
        await registration.dispose();
      } catch (error) {
        disposalError ??= error;
      }
    }

    await hooks.dispose!();

    if (disposalError !== undefined) {
      throw disposalError;
    }
  };
}
