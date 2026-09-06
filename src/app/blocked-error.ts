/**
 * WorkflowBlockedError — the plugin's refusal signal for a tool call.
 *
 * The host's `tool.execute.before` hook is typed `(input, output) => Promise<void>`
 * and exposes no deny field: rewriting `output.args` only changes the arguments
 * the tool receives, it never cancels the call. The host runs the hook as
 * `yield* Effect.promise(() => fn(input, output))` and only then reaches
 * `yield* item.execute(...)`, so a rejected hook is the one and only way to stop
 * the tool from running. The rejection is rendered by `failToolCall` as an
 * errored tool part carrying this message, which is what the agent reads back.
 */
export class WorkflowBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WorkflowBlockedError';
  }
}
