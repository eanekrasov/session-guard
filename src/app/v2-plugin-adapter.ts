import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import { mkdirSync } from 'node:fs';
import { createConsoleLogFn } from './logger.ts';
import { opencodeStateDir, profilesDir, sessionsDir } from './paths.ts';
import { createRuntime, type RuntimeContext, type RuntimeHooks } from './runtime.ts';
import { registerV2Agent, registerV2Commands } from './v2-command-adapter.ts';
import { registerV2ProfileAgents } from './v2-profile-agent-sync.ts';
import { registerWorkflowTools } from './v2-tool-surface-adapter.ts';
import { createV2RuntimeHostAdapter } from './runtime-host-adapter.ts';
import { createRuntime as createRulesRuntime } from '../rules-engine/runtime/create-runtime.js';
import { createRuleMatchContextProvider } from '../rules-engine/runtime/match-context-provider.js';
import { createDebugLog } from '../rules-engine/shared/debug.js';
import {
  parsePluginOptions,
  resolveAdditionalRuleDirectories,
} from '../rules-engine/config/plugin-options.js';
import {
  v2ContextEvent,
  v2HostEvent,
  type V2ContextEvent,
  type V2HostEvent,
  v2PromptEvent,
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

export function createV2ContextHandler(
  handleSystemTransform: RuntimeHooks['handleSystemTransform']
): (event: V2ContextEvent) => Promise<void> {
  return async (event) => {
    const mapped = v2ContextEvent(event);
    const systemOutput = { system: [...mapped.output.system] };
    await handleSystemTransform(mapped.input, systemOutput);
    event.system = systemOutput.system.map((text) => ({ type: 'text' as const, text }));
  };
}

export async function setupV2Runtime(context: Context): Promise<() => Promise<void>> {
  const projectDirectory = v2ProjectDirectory(context);
  const worktreeDirectory = v2WorktreeDirectory(context);
  // V2 instances must derive project-local profiles independently. Reading the
  // process-wide V1 override here would let another plugin instance redirect
  // this adapter while tests or hosts initialize projects concurrently.
  const profileDirectory = profilesDir(projectDirectory, false);
  const sessionStoreDirectory = sessionsDir(opencodeStateDir());
  const pluginOptions = context.options;
  const { additionalRuleDirectories } = parsePluginOptions(context.options);
  const matchContextProvider = createRuleMatchContextProvider({
    projectDirectory: worktreeDirectory,
    debugLog: createDebugLog(),
  });

  ensureDirectory(sessionStoreDirectory);

  const runtimeContext: RuntimeContext = {
    stageInstructionsEnabled: pluginOptions?.stageInstructionsEnabled !== false,
    autoStartEnabled: pluginOptions?.autoStart !== false,
    matchContextProvider,
    host: createV2RuntimeHostAdapter({ context, directory: worktreeDirectory }),
    directory: worktreeDirectory,
  };
  const hooks = createRuntime(runtimeContext, {
    profilesDir: profileDirectory,
    storeDir: sessionStoreDirectory,
  });
  const before = hooks['tool.execute.before']!;
  const after = hooks['tool.execute.after']!;
  const registrations: Registration[] = [];
  let rulesCleanup: (() => Promise<void>) | undefined;
  try {
    const rulesRuntime = await createRulesRuntime({
      client: context,
      directory: worktreeDirectory,
      projectDirectory: worktreeDirectory,
      matchContextProvider,
      additionalRuleDirectories: resolveAdditionalRuleDirectories(
        additionalRuleDirectories,
        projectDirectory
      ),
    });
    rulesCleanup = await rulesRuntime.wire(context, async (event) => {
      if (event.type === 'message.removed' || event.type === 'message.part.updated') {
        await hooks.event!(v2HostEvent(event as V2HostEvent) as never);
      }
    });
    registrations.push(
      await context.tool.hook('execute.before', async (event) => {
        const mapped = v2ToolBeforeEvent(event);
        const input = {
          tool: mapped.tool,
          sessionID: mapped.sessionID,
          callID: mapped.callID,
          agent: mapped.agent,
          messageID: mapped.messageID,
        };
        await before(input, { args: mapped.input });
      })
    );
    registrations.push(
      await context.tool.hook('execute.after', async (event) => {
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
      })
    );
    if (typeof context.session?.hook === 'function') {
      registrations.push(
        await context.session.hook('prompt', async (event) => {
          const mapped = v2PromptEvent(event);
          await hooks.handleChatMessage(mapped.input);
        })
      );
      registrations.push(
        await context.session.hook('context', createV2ContextHandler(hooks.handleSystemTransform))
      );
    }
    const transform = context.tool.transform;
    if (typeof transform === 'function') {
      registrations.push(
        await transform((editor) => {
          registerWorkflowTools(editor, hooks.workflowToolSurface);
        })
      );
    }
    if (typeof context.command?.transform === 'function') {
      registrations.push(await registerV2Commands(context));
    }
    if (typeof context.agent?.transform === 'function') {
      registrations.push(await registerV2Agent(context));
      registrations.push(
        await registerV2ProfileAgents(
          context,
          projectDirectory,
          profileDirectory,
          (message) => void hooks.logMessage('info', message)
        )
      );
    }
  } catch (error) {
    await rulesCleanup?.().catch(() => {});
    await Promise.allSettled(registrations.map((registration) => registration.dispose()));
    await hooks.dispose!().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    await createConsoleLogFn()(
      'error',
      '[ERROR] V2 runtime initialization failed; plugin degraded',
      {
        error: message,
      }
    );
    return async () => {};
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    let disposalError: unknown;
    try {
      await rulesCleanup?.();
    } catch (error) {
      disposalError ??= error;
    }
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
