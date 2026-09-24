import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import { mkdirSync } from 'node:fs';
import { opencodeStateDir, profilesDir, sessionsDir } from './paths.ts';
import { createRuntime, type RuntimeContext } from './runtime.ts';
import { v2ProjectDirectory, v2WorktreeDirectory } from './v2-plugin-contract.ts';

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
    client: context.session as unknown as RuntimeContext['client'],
    directory: worktreeDirectory,
  };
  const hooks = createRuntime(runtimeContext, {
    profilesDir: profileDirectory,
    storeDir: sessionStoreDirectory,
  });
  let registration: Registration;
  try {
    registration = await context.tool.hook('execute.before', async (event) => {
      await hooks['tool.execute.before']!(
        {
          tool: event.tool,
          sessionID: event.sessionID,
          callID: event.id,
        },
        { args: event.input }
      );
    });
  } catch (error) {
    await hooks.dispose!().catch(() => {});
    throw error;
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    let disposalError: unknown;
    try {
      await registration.dispose();
    } catch (error) {
      disposalError = error;
    }

    await hooks.dispose!();

    if (disposalError !== undefined) {
      throw disposalError;
    }
  };
}
