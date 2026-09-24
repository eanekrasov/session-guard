import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import { mkdirSync } from 'node:fs';
import { opencodeStateDir, profilesDir, sessionsDir } from './paths.ts';
import { createRuntime, type RuntimeContext } from './runtime.ts';
import {
  v2ProjectDirectory,
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
  const profileDirectory = profilesDir(projectDirectory);
  const sessionStoreDirectory = sessionsDir(opencodeStateDir());

  ensureDirectory(profileDirectory);
  ensureDirectory(sessionStoreDirectory);

  const runtimeContext: RuntimeContext = {
    // The V2 tool lifecycle uses only location and tool-hook facilities. The
    // shared policy has no verified dependency on V2 session operations.
    client: {},
    directory: worktreeDirectory,
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
