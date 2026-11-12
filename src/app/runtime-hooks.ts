import type { Config, Hooks, ToolDefinition } from '@opencode-ai/plugin';

export interface RuntimeHooksDelegates {
  config(config: Config): Promise<void>;
  chatMessage(
    input: Parameters<NonNullable<Hooks['chat.message']>>[0],
    output: Parameters<NonNullable<Hooks['chat.message']>>[1]
  ): Promise<void>;
  before(
    input: Parameters<NonNullable<Hooks['tool.execute.before']>>[0],
    output: Parameters<NonNullable<Hooks['tool.execute.before']>>[1]
  ): Promise<void>;
  after(
    input: Parameters<NonNullable<Hooks['tool.execute.after']>>[0],
    output: Parameters<NonNullable<Hooks['tool.execute.after']>>[1]
  ): Promise<void>;
  event(input: Parameters<NonNullable<Hooks['event']>>[0]): Promise<void>;
  systemTransform(
    input: Parameters<NonNullable<Hooks['experimental.chat.system.transform']>>[0],
    output: Parameters<NonNullable<Hooks['experimental.chat.system.transform']>>[1]
  ): Promise<void>;
  compacting(
    input: Parameters<NonNullable<Hooks['experimental.session.compacting']>>[0],
    output: Parameters<NonNullable<Hooks['experimental.session.compacting']>>[1]
  ): Promise<void>;
  messagesTransform(
    input: Parameters<NonNullable<Hooks['experimental.chat.messages.transform']>>[0],
    output: Parameters<NonNullable<Hooks['experimental.chat.messages.transform']>>[1]
  ): Promise<void>;
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
