import {
  hasFileObservationFamily,
  matchRuleSnapshots,
  type RuleMatchContext,
  type MatchedRuleEntry,
} from './rule-filter.js';
import { loadRuleSnapshots, type DiscoveredRule, type RuleSnapshot } from './rule-discovery.js';
import { discoverRuleFiles } from './rule-discovery.js';
import {
  extractLatestUserPrompt,
  extractSessionID,
  type MessageWithInfo,
} from './message-context.js';
import { extractConnectedMcpCapabilityIDs } from './mcp-tools.js';
import { createDebugLog, logWarning, formatError, type DebugLog } from './debug.js';
import { SessionStore, type SessionState } from './session-store.js';
import type { MatchedRulesStateStore } from './matched-rules-state.js';
import { buildRuleMatchContext } from './runtime-context.js';
import {
  updateSessionFromChatMessage,
  type ChatMessageInput,
  type ChatMessageOutput,
} from './runtime-chat.js';
import { evaluateHooks, serializeToolArgs } from './rule-hooks.js';
import {
  createRuleDelivery,
  type MatchedHookContent,
  type MatchedRuleContent,
  type RuleDelivery,
} from './rule-delivery.js';
import type { RawHistoryResult } from './rule-delivery-history.js';
import {
  createSessionWorkingContext,
  type SessionWorkingContext,
} from './session-working-context.js';
import {
  createFileObservationContext,
  type FileObservationContext,
} from './file-observation-context.js';
import { isRuleAdmissionPart, type DeliveryPart } from './rule-delivery-codec.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeHostAdapter } from '../app/runtime-host-adapter.ts';

const execAsync = promisify(exec);

export interface MessagesTransformOutput {
  messages: MessageWithInfo[];
}

interface OpenCodeRulesRuntimeOptions {
  host: RuntimeHostAdapter;
  directory: string;
  projectDirectory: string;
  /** Опциональные заранее обнаруженные файлы правил. Когда опущены, рантайм
   * обнаруживает их лениво из директории проекта при первом использовании. */
  ruleFiles?: DiscoveredRule[];
  matchedRulesStateStore: MatchedRulesStateStore;
  debugLog?: DebugLog;
  /** Опциональный внешний session store. Когда предоставлен, рантайм использует его
   * вместо создания своего, так что legacy __testOnly.getSessionStateSnapshot
   * может наблюдать за тем же состоянием. */
  sessionStore?: SessionStore;
}

/** Один объектный ввод для единственного пути оценки session-rule. */
interface SessionRuleEvaluationInput {
  sessionID: string;
  userPrompt: string | undefined;
  modelID: string | undefined;
  agentType: string | undefined;
  selectSnapshot?: (snapshot: RuleSnapshot) => boolean;
}

export class OpenCodeRulesRuntime {
  private host: RuntimeHostAdapter;
  private directory: string;
  private projectDirectory: string;
  private ruleFilesPromise: Promise<DiscoveredRule[]>;
  sessionStore: SessionStore;
  private matchedRulesStateStore: MatchedRulesStateStore;
  private debugLog: DebugLog;
  private ruleDelivery: RuleDelivery;
  private sessionWorkingContext: SessionWorkingContext;
  private fileObservationContext: FileObservationContext;
  private snapshotPromises = new Map<string, Promise<RuleSnapshot[]>>();

  constructor(opts: OpenCodeRulesRuntimeOptions) {
    this.host = opts.host;
    this.directory = opts.directory;
    this.projectDirectory = opts.projectDirectory;
    this.ruleFilesPromise = opts.ruleFiles
      ? Promise.resolve(opts.ruleFiles)
      : discoverRuleFiles(this.projectDirectory);
    this.sessionStore = opts.sessionStore ?? new SessionStore();
    this.matchedRulesStateStore = opts.matchedRulesStateStore;
    this.debugLog = opts.debugLog ?? createDebugLog();
    this.fileObservationContext = createFileObservationContext({
      projectDirectory: opts.projectDirectory,
    });
    this.sessionWorkingContext = createSessionWorkingContext({
      sessionStore: this.sessionStore,
      projectDirectory: opts.projectDirectory,
      readHistory: (sessionID) => this.readClientHistory(sessionID),
      debugLog: this.debugLog,
    });
    this.ruleDelivery = createRuleDelivery({
      rawHistory: this.sessionWorkingContext.rawHistory,
      debugLog: this.debugLog,
      persistAdmission: (sessionID, part) => this.persistRuleAdmission(sessionID, part),
    });
  }

  private async persistRuleAdmission(sessionID: string, part: DeliveryPart): Promise<void> {
    const prompt = this.host.session.prompt;
    if (!prompt || part.type !== 'text' || typeof part.text !== 'string') {
      throw new Error('OpenCode session.prompt is unavailable');
    }
    await prompt({
      path: { id: sessionID },
      query: { directory: this.projectDirectory },
      body: {
        ...(typeof part.messageID === 'string' ? { messageID: part.messageID } : {}),
        noReply: true,
        parts: [
          {
            ...(typeof part.id === 'string' ? { id: part.id } : {}),
            type: 'text',
            text: part.text,
            synthetic: true,
            ...(part.metadata ? { metadata: part.metadata } : {}),
          },
        ],
      },
    });
  }

  private async readClientHistory(sessionID: string): Promise<RawHistoryResult> {
    const messages = this.host.session.messages;
    if (!messages) return { ok: true, messages: [] };
    try {
      const result = await messages({
        path: { id: sessionID },
        query: { directory: this.directory },
      });
      return { ok: true, messages: result?.data ?? [] };
    } catch (error) {
      logWarning('Failed to fetch session history', error);
      return { ok: false };
    }
  }

  /** Called from SessionGuardRuntime on `event` hook. */
  async handleEvent(input: { event?: { type?: unknown; properties?: unknown } }): Promise<void> {
    if (input.event?.type !== 'message.removed') return;
    const properties = input.event.properties;
    if (
      properties === null ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      !('sessionID' in properties) ||
      typeof properties.sessionID !== 'string'
    ) {
      return;
    }

    this.ruleDelivery.markHistoryChanged(properties.sessionID);
    this.sessionWorkingContext.workingContext.invalidateHistoryReads(properties.sessionID);
  }

  /** Called from SessionGuardRuntime on `tool.execute.before` hook. */
  async handleToolExecuteBefore(
    input: { tool?: string; sessionID?: string; callID?: string },
    output: { args?: unknown }
  ): Promise<void> {
    const sessionID = input?.sessionID;
    const toolName = input?.tool;
    const args = output?.args;

    if (!sessionID || !toolName || !args) {
      return;
    }

    // Pre-success: File observation здесь не записывается. Неуспешный или заблокированный
    // execution никогда не должен активировать globs/fileContains правила; только
    // after-hook (успешные события) кормит observation store.
    await this.evaluateAndQueueHooks('PreToolUse', sessionID, toolName, args);
  }

  /** Called from SessionGuardRuntime on `tool.execute.after` hook. */
  async handleToolExecuteAfter(
    input: {
      tool?: string;
      sessionID?: string;
      callID?: string;
      args?: unknown;
    },
    output: { title?: string; output?: string; metadata?: unknown }
  ): Promise<void> {
    const sessionID = input?.sessionID;
    const toolName = input?.tool;
    const args = input?.args;

    if (!sessionID || !toolName || !args) {
      return;
    }

    // Успешные tool events производят File observations; неудачные executions
    // никогда не доходят до этого хука. Output text поддерживает fileContains matching.
    const observations = this.fileObservationContext.recordToolEvent(sessionID, {
      tool: toolName,
      args,
      ...(typeof output?.output === 'string' && output.output.length > 0
        ? { output: output.output }
        : {}),
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
        // Только file-observation-family правила могут быть триггерены свежим
        // observation; другие виды условий оцениваются на диспатче.
        selectSnapshot: (rule) => hasFileObservationFamily(rule.metadata),
      })
    ).filter((rule) => rule.lifetime === 'durable');
    if (matches.length === 0) return;
    const result = await this.ruleDelivery.admitDurableMatches({
      sessionID,
      rules: this.toDeliveryRules(matches),
    });
    if (result === 'accepted') {
      // Union с существующим sidebar state; никогда не затирать ранее
      // матченные правила от durable turns.
      await this.matchedRulesStateStore.merge(
        sessionID,
        matches.map((rule) => rule.filePath)
      );
    }
  }

  /** Called from SessionGuardRuntime on `experimental.chat.messages.transform` hook. */
  async handleMessagesTransform(
    _input: Record<string, never>,
    output: MessagesTransformOutput
  ): Promise<MessagesTransformOutput> {
    const sessionID = extractSessionID(output.messages);
    if (!sessionID) {
      this.debugLog('No sessionID found in messages');
      return output;
    }

    const seededByTransform = this.sessionWorkingContext.workingContext.seedFromSuppliedMessages(
      sessionID,
      output.messages
    );
    if (seededByTransform) {
      const userPrompt = extractLatestUserPrompt(output.messages);
      if (userPrompt) {
        this.sessionStore.upsert(sessionID, (state) => {
          if (!state.lastUserPrompt) {
            state.lastUserPrompt = userPrompt;
          }
        });
        this.debugLog(`Seeded user prompt for session ${sessionID} (len=${userPrompt.length})`);
      }
    }

    let ephemeralRules: MatchedRuleContent[] = [];
    try {
      const currentState = this.sessionStore.get(sessionID);
      if (currentState) {
        const prompt = extractLatestUserPrompt(output.messages);
        const matches = await this.evaluateSessionRules({
          sessionID,
          userPrompt: prompt,
          modelID: currentState.lastModelID,
          agentType: currentState.lastAgentType,
        });
        ephemeralRules = this.toDeliveryRules(
          matches.filter((rule) => rule.lifetime === 'ephemeral')
        );
      }
    } catch (error) {
      this.debugLog(`Ephemeral rule evaluation failed for ${sessionID}: ${formatError(error)}`);
    }
    // Delivery бегает даже когда оценка фейлила: ledger seeding, queue
    // routing, и заqueued transient Hook content не должны промахнуться
    // диспатч.
    this.ruleDelivery.deliverTransientDispatch({
      sessionID,
      matchedRules: ephemeralRules,
      messages: output.messages,
    });
    await this.ruleDelivery.retryPendingAdmissions(sessionID);

    return output;
  }

  /** Загрузить per-session rule snapshot ровно один раз на процесс/сессию,
   * дедуплицируя конкурентные загрузки через promise map. */
  private async ensureSessionRuleSnapshot(sessionID: string): Promise<RuleSnapshot[]> {
    const existing = this.sessionStore.get(sessionID)?.ruleSnapshots;
    if (existing) return existing;

    let pending = this.snapshotPromises.get(sessionID);
    if (!pending) {
      const files = await this.ruleFilesPromise;
      pending = loadRuleSnapshots(files);
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

  /** Собрать shared match context из session state и live queries. */
  private async buildSessionRuleMatchContext(
    sessionID: string,
    userPrompt: string | undefined,
    modelID: string | undefined,
    agentType: string | undefined
  ): Promise<RuleMatchContext> {
    const fileObservations = this.fileObservationContext.getForMatching(sessionID);
    const availableToolIDs = await this.queryAvailableToolIDs();
    return buildRuleMatchContext({
      fileObservations,
      userPrompt,
      availableToolIDs,
      modelID,
      agentType,
      projectDirectory: this.projectDirectory,
      debugLog: this.debugLog,
    });
  }

  /** Оценить session snapshot против текущего request context. */
  private async evaluateSessionRules(
    input: SessionRuleEvaluationInput
  ): Promise<MatchedRuleEntry[]> {
    const snapshots = await this.ensureSessionRuleSnapshot(input.sessionID);
    const selected = input.selectSnapshot ? snapshots.filter(input.selectSnapshot) : snapshots;
    const context = await this.buildSessionRuleMatchContext(
      input.sessionID,
      input.userPrompt,
      input.modelID,
      input.agentType
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

  /** Called from SessionGuardRuntime on `chat.message` hook. */
  async handleChatMessage(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
    try {
      if (output.parts?.some((part) => isRuleAdmissionPart(part))) return;
      const captured = updateSessionFromChatMessage(
        input,
        output,
        this.sessionStore,
        this.debugLog
      );
      const sessionID = input?.sessionID;
      if (!captured || !sessionID) {
        return;
      }

      // 1. Накопить пути файлов, упомянутые в этом сообщении, до durable-turn
      // preparation чтобы matching видел текущие и восстановленные пути.
      if (output.parts && output.parts.length > 0) {
        this.sessionWorkingContext.workingContext.recordMessageParts(sessionID, output.parts);
      }

      await this.sessionWorkingContext.workingContext.prepareDurableTurn(sessionID);

      let matched: MatchedRuleEntry[] = [];
      if (captured.userPrompt) {
        matched = await this.evaluateSessionRules({
          sessionID,
          userPrompt: captured.userPrompt,
          modelID: captured.modelID,
          agentType: captured.agentType,
        });
      }
      const durableMatches = matched.filter((rule) => rule.lifetime === 'durable');

      const messageID = input.messageID ?? output.message?.id;
      const result = await this.ruleDelivery.deliverDurableTurn({
        sessionID,
        ...(messageID ? { messageID } : {}),
        matchedRules: this.toDeliveryRules(durableMatches),
        output,
      });

      if (result === 'accepted' && captured.userPrompt) {
        await this.matchedRulesStateStore.write(
          sessionID,
          matched.map((r) => r.filePath)
        );
      }
    } catch (error) {
      this.debugLog(`chat.message handler failed: ${formatError(error)}`);
    }
  }

  private async queryAvailableToolIDs(): Promise<string[]> {
    const list = this.host.tools.list;
    if (!list) return [];
    try {
      const tools = await list();
      const ids = tools.map(({ id }) => id);
      this.debugLog(
        `Available tools: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? '...' : ''} (${ids.length} total)`
      );
      return Array.from(new Set(ids));
    } catch (error) {
      logWarning('Failed to query available tools', error);
      return [];
    }
  }

  /** Called from SessionGuardRuntime on `experimental.session.compacting` hook. */
  async handleSessionCompacting(
    input: { sessionID?: string },
    output: { context?: string[] }
  ): Promise<void> {
    const sessionID = input?.sessionID;
    if (!sessionID) {
      this.debugLog('No sessionID in compacting hook input');
      return;
    }

    this.ruleDelivery.markCompacted(sessionID);

    const projection = this.sessionWorkingContext.workingContext.prepareForCompaction(sessionID);
    if (!projection) {
      this.debugLog(`No context paths for session ${sessionID} during compaction`);
      return;
    }

    if (!output.context) {
      output.context = [];
    }

    output.context.push(projection);

    this.debugLog(`Added Working-context projection to compaction for session ${sessionID}`);
  }

  private async executeHookSideEffect(command: string, sessionID: string): Promise<void> {
    try {
      this.debugLog(`Executing hook side-effect for session ${sessionID}: ${command}`);
      await execAsync(command, { cwd: this.projectDirectory });
      this.debugLog(`Hook side-effect completed for session ${sessionID}: ${command}`);
    } catch (error) {
      logWarning('Hook side-effect failed', error);
    }
  }

  /** Оценить хуки для вызова инструмента и заqueued матчи.
   * @throws {Error} Когда PreToolUse хук с block:true матчит инструмент и аргументы. */
  private async evaluateAndQueueHooks(
    hookType: 'PreToolUse' | 'PostToolUse',
    sessionID: string,
    toolName: string,
    args: unknown
  ): Promise<void> {
    const serializedArgs = serializeToolArgs(args);

    const snapshots = await this.ensureSessionRuleSnapshot(sessionID);

    // First pass: собрать все матченные хуки по всем правилам
    const allMatches: Array<{
      hook: { type: string; run?: string };
      rule: RuleSnapshot;
    }> = [];

    for (const rule of snapshots) {
      if (!rule.metadata?.hooks) continue;

      const typeFiltered = rule.metadata.hooks.filter((h) => h.type === hookType);
      if (typeFiltered.length === 0) continue;

      const matched = evaluateHooks(typeFiltered, {
        toolName,
        serializedArgs,
        hookType,
      });

      for (const hook of matched) {
        allMatches.push({ hook, rule });
      }
    }

    if (allMatches.length === 0) return;

    // Построить shared classification context только когда хуки реально
    // сматчились: context query (tool RPCs, project tags, git branch) —
    // дорогая часть tool-event path.
    const state = this.sessionStore.get(sessionID);
    const matchContext = await this.buildSessionRuleMatchContext(
      sessionID,
      state?.lastUserPrompt,
      state?.lastModelID,
      state?.lastAgentType
    );

    // Check for blockers globally before any queuing or side-effects
    if (hookType === 'PreToolUse') {
      const blocker = allMatches.find(
        (m) => m.hook.type === 'PreToolUse' && (m.hook as { block?: boolean }).block
      );
      if (blocker) {
        this.debugLog(
          `PreToolUse block fired for rule ${blocker.rule.relativePath}, tool ${toolName}`
        );
        throw new Error(
          `[opencode-rules] Blocked by rule "${blocker.rule.relativePath}": ` +
            `tool "${toolName}" matched blocked pattern`
        );
      }
    }

    // Нет блокеров: заqueue content и запустить side-effects
    // Заqueue каждый матченный rule один раз, сколько бы хуков ни сматчилось.
    const seenRules = new Set<string>();
    const matchedHooks: MatchedHookContent[] = [];
    for (const { hook, rule } of allMatches) {
      if (!seenRules.has(rule.filePath)) {
        seenRules.add(rule.filePath);
        const lifetime = matchRuleSnapshots([rule], matchContext)[0]?.lifetime ?? 'ephemeral';
        matchedHooks.push({
          identity: rule.filePath,
          relativePath: rule.relativePath,
          name: rule.name,
          content: rule.strippedContent,
          lifetime,
        });

        this.debugLog(
          `${hookType} hook fired for rule ${rule.relativePath}, tool ${toolName} (${lifetime})`
        );
      }

      if (hook.run) {
        await this.executeHookSideEffect(hook.run, sessionID);
      }
    }
    if (matchedHooks.length > 0) {
      this.ruleDelivery.queueMatchedHooks({
        sessionID,
        hooks: matchedHooks,
      });
    }
  }

  /** Создать test-only hooks объект, совместимый со старыми тестовыми ожиданиями.
   * Возвращает ту же форму, что createHooks() раньше возвращал, делегируя
   * новым публичным методам. */
  createTestHooks(): Record<string, unknown> {
    return {
      'tool.execute.before': this.handleToolExecuteBefore.bind(this),
      'tool.execute.after': this.handleToolExecuteAfter.bind(this),
      'experimental.chat.messages.transform': this.handleMessagesTransform.bind(this),
      'chat.message': this.handleChatMessage.bind(this),
      'experimental.session.compacting': this.handleSessionCompacting.bind(this),
      event: this.handleEvent.bind(this),
    };
  }
}
