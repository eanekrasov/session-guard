/**
 * Adapted from opencode-rules@1.0.0 (rules-v1@154d8d9): the v1 orchestrator
 * consumed the v1 client (`OpenCodeClient`) internally. Reworked in session-guard
 * to consume opencode V2 hook payloads and a `V2DeliverySink` (synthetic),
 * and to build its match context through `RuleMatchContextProvider`.
 */
import {
  hasFileObservationFamily,
  matchRuleSnapshots,
  type RuleMatchContext,
  type MatchedRuleEntry,
} from '../rules/rule-filter.js';
import {
  loadRuleSnapshots,
  type DiscoveredRule,
  type RuleSnapshot,
} from '../rules/rule-discovery.js';
import type { MessageWithInfo } from '../session/message-extraction.js';
import { fromContextMessages } from '../session/v2-messages.js';
import { createDebugLog, formatError, type DebugLog } from '../shared/debug.js';
import type { SessionStore } from '../session/session-store.js';
import type { MatchedRulesStateStore } from '../session/matched-rules-state.js';
import { captureSessionContext, captureSessionPrompt } from './chat-capture.js';
import {
  createRuleDelivery,
  type MatchedRuleContent,
  type RuleDelivery,
} from '../delivery/rule-delivery.js';
import {
  createSessionWorkingContext,
  type SessionWorkingContext,
} from '../session/session-working-context.js';
import type { RuleMatchContextProvider } from './match-context-provider.js';
import { createRuleMatchContextProvider } from './match-context-provider.js';
import type { DeliveryPart } from '../delivery/rule-delivery-codec.js';
import type { RuntimePort } from './runtime-port.js';
import { ToolHookFlow } from './tool-hook-flow.js';

// v2 hook payloads, kept structural so the orchestrator stays testable
// without importing the beta package's Effect-branded types.
export interface V2ToolExecuteBeforeInput {
  tool?: string;
  sessionID?: string;
  agent?: string;
  messageID?: string;
  id?: string;
  input?: unknown;
}

export interface V2ToolExecuteAfterInput {
  tool?: string;
  sessionID?: string;
  agent?: string;
  messageID?: string;
  id?: string;
  input?: unknown;
  status?: string;
  result?: { output?: unknown; content?: unknown; metadata?: unknown };
  error?: unknown;
}

export interface V2SessionContextInput {
  sessionID?: string;
  agent?: string;
  /** v2 hook shape: Model.Ref ({ providerID, id, variant? }); id is the model ID. */
  model?: { id?: string; providerID?: string; variant?: string };
  messages?: unknown;
  tools?: Record<string, unknown>;
}

export interface V2SessionPromptInput {
  sessionID?: string;
  messageID?: string;
  prompt?: { text?: string };
}

export interface V2EventInput {
  type?: string;
  data?: unknown;
}

export interface V2DeliverySink {
  /** Durable injection: ctx.session.synthetic. */
  synthetic(input: {
    sessionID: string;
    id: string;
    text: string;
    metadata?: { ruleKeys?: string[]; hookKeys?: string[] };
    resume?: boolean;
  }): Promise<unknown>;
}

interface HookRegistration {
  dispose(): Promise<void>;
}

interface OpenCodeRulesRuntimeOptions {
  directory: string;
  projectDirectory: string;
  ruleFiles: DiscoveredRule[];
  sessionStore: SessionStore;
  matchedRulesStateStore: MatchedRulesStateStore;
  matchContextProvider?: RuleMatchContextProvider;
  /** Host operations; supplied by the platform adapter (v2 host or v1 hooks). */
  port: RuntimePort;
  debugLog?: DebugLog;
}

interface SessionRuleEvaluationInput {
  sessionID: string;
  userPrompt: string | undefined;
  modelID: string | undefined;
  agentType: string | undefined;
  selectSnapshot?: (snapshot: RuleSnapshot) => boolean;
}

export class OpenCodeRulesRuntime {
  private directory: string;
  private ruleFiles: DiscoveredRule[];
  private sessionStore: SessionStore;
  private matchedRulesStateStore: MatchedRulesStateStore;
  private debugLog: DebugLog;
  private port: RuntimePort;
  private toolHookFlow: ToolHookFlow;
  private ruleDelivery: RuleDelivery;
  private sessionWorkingContext: SessionWorkingContext;
  private matchContextProvider: RuleMatchContextProvider;
  private snapshotPromises = new Map<string, Promise<RuleSnapshot[]>>();
  private deliverySink: V2DeliverySink | null = null;

  constructor(opts: OpenCodeRulesRuntimeOptions) {
    this.directory = opts.directory;
    this.ruleFiles = opts.ruleFiles;
    this.matchContextProvider =
      opts.matchContextProvider ??
      createRuleMatchContextProvider({
        projectDirectory: opts.projectDirectory,
        sessionStore: opts.sessionStore,
        debugLog: opts.debugLog ?? createDebugLog(),
      });
    this.sessionStore = this.matchContextProvider.sessionStore;
    this.matchedRulesStateStore = opts.matchedRulesStateStore;
    this.debugLog = opts.debugLog ?? createDebugLog();
    this.port = opts.port;
    this.sessionWorkingContext = createSessionWorkingContext({
      sessionStore: opts.sessionStore,
      projectDirectory: opts.projectDirectory,
      readHistory: (sessionID) => this.port.readHistory(sessionID),
      debugLog: this.debugLog,
    });
    this.ruleDelivery = createRuleDelivery({
      rawHistory: this.sessionWorkingContext.rawHistory,
      debugLog: this.debugLog,
      persistAdmission: (sessionID, part) => this.port.persistAdmission(sessionID, part),
    });
    this.toolHookFlow = new ToolHookFlow({
      debugLog: this.debugLog,
      projectDirectory: opts.projectDirectory,
      ensureSessionRuleSnapshot: (sessionID) => this.ensureSessionRuleSnapshot(sessionID),
      buildMatchContext: (sessionID, includeStage) =>
        this.buildSessionRuleMatchContext(sessionID, undefined, undefined, undefined, includeStage),
      queueMatchedHooks: (input) => this.ruleDelivery.queueMatchedHooks(input),
    });
  }

  /**
   * Registers the v2 hooks on a plugin context and starts the event loop.
   * Returns a cleanup function disposing registrations and stopping the
   * event loop. The registered callbacks stay reachable through the context
   * for tests, which pass a mock context and invoke handlers directly.
   */
  async wire(
    context: {
      tool: {
        hook(
          name: 'execute.before',
          handler: (input: V2ToolExecuteBeforeInput) => Promise<void> | void
        ): Promise<HookRegistration>;
        hook(
          name: 'execute.after',
          handler: (input: V2ToolExecuteAfterInput) => Promise<void> | void
        ): Promise<HookRegistration>;
      };
      session?: {
        hook?: {
          (
            name: 'context',
            handler: (input: V2SessionContextInput) => Promise<void> | void
          ): Promise<HookRegistration>;
          (
            name: 'prompt',
            handler: (input: V2SessionPromptInput) => Promise<void> | void
          ): Promise<HookRegistration>;
        };
        synthetic?: V2DeliverySink['synthetic'];
      };
      event: {
        subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2EventInput>;
      };
    },
    onEvent?: (event: V2EventInput) => Promise<void> | void
  ): Promise<() => Promise<void>> {
    // Keep the session domain so sink calls (synthetic) stay method-bound.
    this.deliverySink = this.port.synthetic
      ? { synthetic: this.port.synthetic }
      : context.session?.synthetic
        ? {
            synthetic: (input, ...rest) => context.session!.synthetic!(input, ...rest),
          }
        : null;

    const registrations: HookRegistration[] = [];
    try {
      registrations.push(
        await context.tool.hook('execute.before', (input) => this.onToolExecuteBefore(input))
      );
      registrations.push(
        await context.tool.hook('execute.after', (input) => this.onToolExecuteAfter(input))
      );
      if (context.session?.hook) {
        registrations.push(
          await context.session.hook('context', (input) => this.onSessionContext(input))
        );
        registrations.push(
          await context.session.hook('prompt', (input) => this.onSessionPrompt(input))
        );
      }
    } catch (error) {
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => undefined);
      }
      throw error;
    }

    const abortController = new AbortController();
    const eventLoop = this.runEventLoop(context.event, abortController.signal, onEvent);

    return async () => {
      abortController.abort();
      await Promise.race([
        eventLoop.catch(() => undefined),
        new Promise<void>((resolve) => {
          if (abortController.signal.aborted) resolve();
          else abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => undefined);
      }
    };
  }

  private async runEventLoop(
    eventDomain: {
      subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2EventInput>;
    },
    signal: AbortSignal,
    onEvent?: (event: V2EventInput) => Promise<void> | void
  ): Promise<void> {
    let events: AsyncIterable<V2EventInput>;
    try {
      events = await eventDomainSubscribe(eventDomain, signal);
    } catch (error) {
      this.debugLog(`Event subscription failed: ${formatError(error)}`);
      return;
    }
    for await (const event of events) {
      if (signal.aborted) return;
      try {
        this.onEvent(event);
        await onEvent?.(event);
      } catch (error) {
        this.debugLog(`Event handler failed: ${formatError(error)}`);
      }
    }
  }

  /**
   * v2 event stream. The v1 `message.removed` event is gone; revert events
   * (staged/committed/cleared) are the message-removal mechanism that can
   * drop a durable delivery part from history.
   */
  private onEvent(event: V2EventInput): void {
    const type = event?.type;
    const data = event?.data;
    const sessionID =
      data !== null && typeof data === 'object' && 'sessionID' in data ? data.sessionID : undefined;
    if (typeof sessionID !== 'string') return;

    if (
      type === 'message.removed' ||
      type === 'session.revert.staged' ||
      type === 'session.revert.committed' ||
      type === 'session.revert.cleared'
    ) {
      this.ruleDelivery.markHistoryChanged(sessionID);
      this.sessionWorkingContext.workingContext.invalidateHistoryReads(sessionID);
      return;
    }

    // Compaction invalidation only; projection rides the next context
    // dispatch (map ticket #73).
    if (type === 'session.compaction.started' || type === 'session.compaction.ended') {
      this.ruleDelivery.markCompacted(sessionID);
      this.sessionWorkingContext.workingContext.invalidateHistoryReads(sessionID);
      this.sessionStore.upsert(sessionID, (state) => {
        state.compacted = true;
        state.matchedStateTracking = false;
      });
    }
  }

  private async onToolExecuteBefore(input: V2ToolExecuteBeforeInput): Promise<void> {
    const sessionID = input?.sessionID;
    const toolName = input?.tool;
    const args = input?.input;

    if (!sessionID || !toolName || !isRecord(args)) {
      return;
    }

    // A failed or blocked execution must never activate globs/fileContains
    // rules; only successful after-hook events feed the observation store.
    await this.evaluateAndQueueHooks('PreToolUse', sessionID, toolName, args);
  }

  private async onToolExecuteAfter(input: V2ToolExecuteAfterInput): Promise<void> {
    const sessionID = input?.sessionID;
    const toolName = input?.tool;
    const args = input?.input;

    if (!sessionID || !toolName || !isRecord(args)) {
      return;
    }

    // A failed execution never activates globs/fileContains rules.
    if (input?.status !== 'completed') return;

    // Output text supports fileContains matching; result.content is a
    // string or a Content[] array in v2.
    const output = extractToolResultText(input.result);
    const observations = this.matchContextProvider.recordToolEvent(sessionID, {
      tool: toolName,
      args,
      ...(output !== undefined && output.length > 0 ? { output } : {}),
    });
    this.sessionWorkingContext.workingContext.recordObservations(sessionID, observations);

    if (observations.length > 0) {
      await this.admitObservationMatches(sessionID);
    }

    await this.evaluateAndQueueHooks('PostToolUse', sessionID, toolName, args);
  }

  private async admitObservationMatches(sessionID: string): Promise<void> {
    const state = this.sessionStore.get(sessionID);
    const matches = (
      await this.evaluateSessionRules({
        sessionID,
        userPrompt: state?.lastUserPrompt,
        modelID: state?.lastModelID,
        agentType: state?.lastAgentType,
        // Only file-observation-family rules can be triggered by a fresh
        // observation; other condition kinds are evaluated per dispatch.
        selectSnapshot: (rule) => hasFileObservationFamily(rule.metadata),
      })
    ).filter((rule) => rule.lifetime === 'durable');
    if (matches.length === 0) return;
    const result = await this.ruleDelivery.admitDurableMatches({
      sessionID,
      rules: this.toDeliveryRules(matches),
    });
    if (result === 'accepted') {
      // Union, never replace: an admission must not clobber sidebar state
      // written by durable turns.
      await this.matchedRulesStateStore.merge(
        sessionID,
        matches.map((rule) => rule.filePath)
      );
    }
  }

  /**
   * Session `context` hook: per-dispatch transient injection. Replaces v1's
   * experimental.chat.messages.transform; mutates input.messages in place.
   */
  private async onSessionContext(input: V2SessionContextInput): Promise<void> {
    const sessionID = input?.sessionID;
    if (!sessionID || !Array.isArray(input?.messages)) {
      this.debugLog('No sessionID or messages in session context hook input');
      return;
    }

    // Available-tool tracking: the context hook's tool table replaces v1's
    // tool.ids RPC as the built-in tool source.
    if (input.tools !== undefined) {
      const toolIDs = Object.keys(input.tools);
      this.matchContextProvider.setAvailableToolIDs(sessionID, toolIDs);
    }

    // Normalize AI Messages into the internal { info, parts } form; the
    // appended transient messages are converted back to v2 shape below.
    const messages = fromContextMessages(input.messages);

    const captured = captureSessionContext(
      {
        sessionID,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        messages,
      },
      this.sessionStore,
      this.debugLog
    );

    const seededByContext = this.sessionWorkingContext.workingContext.seedFromSuppliedMessages(
      sessionID,
      messages
    );
    if (seededByContext && !captured?.userPrompt) {
      const userPrompt = latestUserPromptFromMessages(messages);
      if (userPrompt) {
        this.sessionStore.upsert(sessionID, (state) => {
          if (!state.lastUserPrompt) state.lastUserPrompt = userPrompt;
        });
        this.debugLog(`Seeded user prompt for session ${sessionID} (len=${userPrompt.length})`);
      }
    }

    let ephemeralRules: MatchedRuleContent[] = [];
    let matchedForState: MatchedRuleEntry[] = [];
    let refreshMatchedState = false;
    try {
      const currentState = this.sessionStore.get(sessionID);
      if (currentState) {
        const prompt = captured?.userPrompt ?? latestUserPromptFromMessages(messages);
        const matches = await this.evaluateSessionRules({
          sessionID,
          userPrompt: prompt,
          modelID: currentState.lastModelID,
          agentType: currentState.lastAgentType,
        });
        refreshMatchedState = currentState.matchedStateTracking === true;
        matchedForState = matches;
        ephemeralRules = this.toDeliveryRules(
          matches.filter((rule) => rule.lifetime === 'ephemeral')
        );
      }
    } catch (error) {
      this.debugLog(`Ephemeral rule evaluation failed for ${sessionID}: ${formatError(error)}`);
    }
    // Delivery runs even when evaluation failed: ledger seeding, queue
    // routing, and queued transient Hook content must not slip a dispatch.
    const messagesBefore = messages.length;
    this.ruleDelivery.deliverTransientDispatch({
      sessionID,
      matchedRules: ephemeralRules,
      messages: messages,
    });
    for (const appended of messages.slice(messagesBefore)) {
      input.messages.push(
        internalToV2Message(appended as MessageWithInfo & { parts?: DeliveryPart[] })
      );
    }
    const retriedRules = await this.ruleDelivery.retryPendingAdmissions(sessionID);
    const retriedPaths = retriedRules.map((rule) => rule.identity ?? rule.relativePath);

    if (refreshMatchedState) {
      const paths = new Set(matchedForState.map((rule) => rule.filePath));
      for (const path of retriedPaths) paths.add(path);
      await this.matchedRulesStateStore.writeIfChanged(sessionID, [...paths]);
    } else if (retriedPaths.length > 0) {
      await this.matchedRulesStateStore.merge(sessionID, retriedPaths);
    }

    // Compacted-session projection: v1 used the compaction hook's
    // output.context channel; v2 has none, so the projection rides the
    // next context dispatch.
    this.deliverCompactionProjection(sessionID, input.messages);
  }

  private deliverCompactionProjection(sessionID: string, messages: unknown): void {
    let compacted = false;
    this.sessionStore.upsert(sessionID, (state) => {
      compacted = state.compacted === true;
      if (compacted) state.compacted = false;
    });
    if (!compacted) return;
    const projection = this.sessionWorkingContext.workingContext.prepareForCompaction(sessionID);
    if (!projection) {
      this.debugLog(`No context paths for session ${sessionID} during compaction`);
      return;
    }
    if (Array.isArray(messages)) {
      messages.push({
        id: 'msg_rules_compact_projection',
        role: 'user',
        content: [{ type: 'text', text: projection }],
      });
    }
    this.debugLog(`Added Working-context projection to dispatch for session ${sessionID}`);
  }

  private async ensureSessionRuleSnapshot(sessionID: string): Promise<RuleSnapshot[]> {
    const existing = this.sessionStore.get(sessionID)?.ruleSnapshots;
    if (existing) return existing;

    let pending = this.snapshotPromises.get(sessionID);
    if (!pending) {
      pending = loadRuleSnapshots(this.ruleFiles);
      this.snapshotPromises.set(sessionID, pending);
    }

    try {
      const loaded = await pending;
      this.sessionStore.upsert(sessionID, (state) => {
        if (!state.ruleSnapshots) state.ruleSnapshots = loaded;
      });
      return this.sessionStore.get(sessionID)?.ruleSnapshots ?? loaded;
    } finally {
      if (this.snapshotPromises.get(sessionID) === pending) {
        this.snapshotPromises.delete(sessionID);
      }
    }
  }

  private async buildSessionRuleMatchContext(
    sessionID: string,
    userPrompt?: string,
    modelID?: string,
    agentType?: string,
    includeStage = false
  ): Promise<RuleMatchContext> {
    const availableToolIDs = await this.port.queryAvailableToolIDs(
      this.matchContextProvider.getAvailableToolIDs(sessionID)
    );
    if (userPrompt !== undefined || modelID !== undefined || agentType !== undefined) {
      this.sessionStore.upsert(sessionID, (current) => {
        if (userPrompt !== undefined) current.lastUserPrompt = userPrompt;
        if (modelID !== undefined) current.lastModelID = modelID;
        if (agentType !== undefined) current.lastAgentType = agentType;
      });
    }
    return this.matchContextProvider.getMatchContext(sessionID, availableToolIDs, includeStage);
  }

  private async evaluateSessionRules(
    input: SessionRuleEvaluationInput
  ): Promise<MatchedRuleEntry[]> {
    const snapshots = await this.ensureSessionRuleSnapshot(input.sessionID);
    const selected = input.selectSnapshot ? snapshots.filter(input.selectSnapshot) : snapshots;
    const context = await this.buildSessionRuleMatchContext(
      input.sessionID,
      input.userPrompt,
      input.modelID,
      input.agentType,
      selected.some((snapshot) => snapshot.metadata?.stage !== undefined)
    );
    return matchRuleSnapshots(selected, context);
  }

  private toDeliveryRules(matches: readonly MatchedRuleEntry[]): MatchedRuleContent[] {
    return matches.map((rule) => ({
      identity: rule.filePath,
      relativePath: rule.relativePath,
      name: rule.name,
      content: rule.strippedContent,
    }));
  }

  /**
   * Session `prompt` hook: durable-rule delivery per admitted user prompt.
   * Replaces v1's chat.message handler. Delivery reuses the existing
   * RuleDelivery engine against a virtual output, then publishes each
   * appended durable part via ctx.session.synthetic: v2 hook handlers
   * cannot append parts to the user message, and synthetic messages persist
   * into history so the ledger keeps working.
   */
  private async onSessionPrompt(input: V2SessionPromptInput): Promise<void> {
    try {
      const sessionID = input?.sessionID;
      const promptText = input?.prompt?.text;
      if (!sessionID || !promptText) return;

      // Defensive: a legacy prompt-path admission in flight (or any other
      // replay of our own framing) must never be treated as a user turn.
      if (promptText.startsWith('<system-message>')) return;

      this.sessionStore.upsert(sessionID, (state) => {
        state.matchedStateTracking = false;
      });

      const captured = captureSessionPrompt(input, this.sessionStore, this.debugLog);

      // Accumulate paths from history before durable-turn preparation so
      // matching sees current and restored paths together.
      await this.sessionWorkingContext.workingContext.prepareDurableTurn(sessionID);

      let matched: MatchedRuleEntry[] = [];
      if (captured?.userPrompt) {
        const state = this.sessionStore.get(sessionID);
        matched = await this.evaluateSessionRules({
          sessionID,
          userPrompt: captured.userPrompt,
          modelID: state?.lastModelID,
          agentType: state?.lastAgentType,
        });
      }
      const durableMatches = matched.filter((rule) => rule.lifetime === 'durable');

      const messageID = input?.messageID;
      const output: { parts?: DeliveryPart[] } = {};
      const result = await this.ruleDelivery.deliverDurableTurn({
        sessionID,
        ...(messageID !== undefined ? { messageID } : {}),
        matchedRules: this.toDeliveryRules(durableMatches),
        output,
      });

      if (result !== 'accepted') return;

      const sink = this.deliverySink;
      if (!sink) {
        throw new Error('ctx.session.synthetic is unavailable');
      }
      for (const part of output.parts ?? []) {
        if (part.type !== 'text' || typeof part.id !== 'string') continue;
        const ruleKeys = part.metadata?.ruleKeys;
        const hookKeys = part.metadata?.hookKeys;
        const metadata = {
          ...(Array.isArray(ruleKeys)
            ? { ruleKeys: ruleKeys.filter((key): key is string => typeof key === 'string') }
            : {}),
          ...(Array.isArray(hookKeys)
            ? { hookKeys: hookKeys.filter((key): key is string => typeof key === 'string') }
            : {}),
        };
        // v2 validates synthetic ids as Session.Message.ID ("msg_" prefix);
        // the codec's "prt_rules_" part id is an internal identity and must
        // be converted to idempotency-stable message form.
        // resume:false is required: the prompt hook runs before the user
        // message is dispatched, so a scheduled run would execute on a
        // context containing only the rule block.
        await sink.synthetic({
          sessionID,
          id: syntheticMessageId(part.id),
          text: typeof part.text === 'string' ? part.text : '',
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          resume: false,
        });
      }

      if (captured?.userPrompt) {
        await this.matchedRulesStateStore.write(
          sessionID,
          matched.map((r) => r.filePath)
        );
        this.sessionStore.upsert(sessionID, (state) => {
          state.matchedStateTracking = true;
        });
      }
    } catch (error) {
      this.debugLog(`session.prompt handler failed: ${formatError(error)}`);
    }
  }

  /** @throws when a blocking PreToolUse hook matches. */
  private async evaluateAndQueueHooks(
    hookType: 'PreToolUse' | 'PostToolUse',
    sessionID: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    await this.toolHookFlow.evaluateAndQueueHooks(hookType, sessionID, toolName, args);
  }
}

async function eventDomainSubscribe(
  eventDomain: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2EventInput>;
  },
  signal: AbortSignal
): Promise<AsyncIterable<V2EventInput>> {
  return eventDomain.subscribe({ signal });
}

function extractToolResultText(
  result: { output?: unknown; content?: unknown } | undefined
): string | undefined {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const value of content) {
      if (value === null || typeof value !== 'object') continue;
      const type = Reflect.get(value, 'type');
      const text = Reflect.get(value, 'text');
      if (type === 'text' && typeof text === 'string') texts.push(text);
    }
    if (texts.length > 0) return texts.join('\n');
  }
  const output = result?.output;
  if (typeof output === 'string') return output;
  return undefined;
}

// v2 synthetic admission validates ids as Session.Message.ID ("msg_"
// prefix) and rejects anything else. Derive a stable "msg_" id from the
// codec part id so retries with the same rules keep idempotency.
function syntheticMessageId(partId: string): string {
  if (partId.startsWith('msg_')) return partId;
  return `msg_${partId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latestUserPromptFromMessages(messages: readonly MessageWithInfo[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.info?.role !== 'user') continue;
    const parts = message.parts ?? [];
    for (const part of parts) {
      if (part.synthetic) continue;
      if (part.type === 'text' && part.text) return part.text;
    }
  }
  return undefined;
}

function internalToV2ContentPart(part: DeliveryPart): unknown {
  return {
    type: 'text',
    text: part.text ?? '',
    ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
  };
}

function internalToV2Message(message: MessageWithInfo & { parts?: DeliveryPart[] }): unknown {
  return {
    ...(message.info?.id !== undefined ? { id: message.info.id } : {}),
    role: message.info?.role ?? 'user',
    content: (message.parts ?? []).map(internalToV2ContentPart),
  };
}
