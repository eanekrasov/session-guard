export interface ToolInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: unknown;
}

export type BeforeOutput = { args: unknown };
export type AfterOutput = { title: string; output: string; metadata: unknown };

export interface HookHandler {
  readonly tools?: ReadonlySet<string>;
  before?(input: ToolInput, output: BeforeOutput): Promise<boolean | void>;
  after?(input: ToolInput, output: AfterOutput): Promise<boolean | void>;
}
