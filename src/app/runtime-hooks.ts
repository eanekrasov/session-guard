import type { Config, Hooks, ToolDefinition } from '@opencode-ai/plugin';

export interface RuntimeHooksDelegates {
  config(config: Config): Promise<void>;
  chatMessage(input: unknown, output: unknown): Promise<void>;
  before(input: unknown, output: unknown): Promise<void>;
  after(input: unknown, output: unknown): Promise<void>;
  event(input: unknown): Promise<void>;
  systemTransform(input: unknown, output: unknown): Promise<void>;
  compacting(input: unknown, output: unknown): Promise<void>;
  messagesTransform(input: unknown, output: unknown): Promise<void>;
  dispose(): Promise<void>;
  tools: Record<string, ToolDefinition>;
}

export function createRuntimeHooks(delegates: RuntimeHooksDelegates): Hooks {
  return {
    config: async (config) => delegates.config(config),
    tool: delegates.tools,
    'chat.message': async (input, output) => delegates.chatMessage(input, output),
    'tool.execute.before': async (input, output) => delegates.before(input, output),
    'tool.execute.after': async (input, output) => delegates.after(input, output),
    event: async (input) => delegates.event(input),
    'experimental.chat.system.transform': async (input, output) =>
      delegates.systemTransform(input, output),
    'experimental.session.compacting': async (input, output) => delegates.compacting(input, output),
    'experimental.chat.messages.transform': async (input, output) =>
      delegates.messagesTransform(input, output),
    dispose: async () => delegates.dispose(),
  };
}
