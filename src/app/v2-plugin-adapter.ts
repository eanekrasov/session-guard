import type { Context } from '@opencode/plugin/promise/plugin';
import type { Registration } from '@opencode/plugin/promise/registration';
import { mkdirSync } from 'node:fs';
import { opencodeStateDir, profilesDir, sessionsDir } from './paths.ts';
import { createRuntime, type RuntimeContext } from './runtime.ts';
import { registerV2Agent, registerV2Commands } from './v2-command-adapter.ts';
import { registerV2ProfileAgents } from './v2-profile-agent-sync.ts';
import { registerWorkflowTools } from './v2-tool-surface-adapter.ts';
import { createV2RuntimeHostAdapter } from './runtime-host-adapter.ts';
import {
  v2ContextEvent,
  v2MessagesFromLegacy,
  v2HostEvent,
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

async function registerV2Events(
  context: Context,
  handleEvent: (event: ReturnType<typeof v2HostEvent>) => Promise<void>
): Promise<() => Promise<void>> {
  const controller = new AbortController();
  try {
    const events = context.event.subscribe({ signal: controller.signal }) as AsyncIterable<{
      readonly type: string;
      readonly data: unknown;
    }>;
    void (async () => {
      try {
        for await (const event of events) {
          if (event.type === 'message.removed' || event.type === 'message.part.updated') {
            await handleEvent(v2HostEvent(event as V2HostEvent));
          }
        }
      } catch {
        if (!controller.signal.aborted) return;
      }
    })();
    return async () => controller.abort();
  } catch (error) {
    controller.abort();
    throw error;
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
    host: createV2RuntimeHostAdapter({ context, directory: worktreeDirectory }),
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
  let eventCleanup: (() => Promise<void>) | undefined;
  try {
    registrations.push(
      await context.tool.hook('execute.before', async (event) => {
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
          await hooks['chat.message']!(mapped.input, mapped.output as never);
        })
      );
      registrations.push(
        await context.session.hook('context', async (event) => {
          const mapped = v2ContextEvent(event);
          const system = [...mapped.output.system];
          const messages = [...mapped.output.messages];
          await hooks['experimental.chat.system.transform']!(mapped.input as never, { system });
          await hooks['experimental.chat.messages.transform']!(
            { sessionID: event.sessionID },
            { messages: messages as never }
          );
          event.system = system.map((text) => ({ type: 'text' as const, text }));
          event.messages = v2MessagesFromLegacy(messages, event.sessionID);
        })
      );
    }
    if (typeof context.event?.subscribe === 'function') {
      eventCleanup = await registerV2Events(context, (event) => hooks.event!(event as never));
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
    await eventCleanup?.();
    await Promise.allSettled(registrations.map((registration) => registration.dispose()));
    await hooks.dispose!().catch(() => {});
    throw error;
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    let disposalError: unknown;
    await eventCleanup?.();
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
