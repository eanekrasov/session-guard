/**
 * Parity harness: runs identical rule scenarios through the V1 delivery path
 * and the V2 delivery path, returning comparable `ParityDelivery` records.
 *
 * V2 path: mock v2 context (`createMockPluginInput` + `createMockRuntimePort`)
 * wired via `runtime.wire`; durable rides `port.synthetic` (recorded in
 * `syntheticCalls`), observation admissions ride `port.persistAdmission`,
 * transient rides the session-context hook message appends.
 *
 * V1 path: the production V1 link used by `src/v1/plugin.ts` —
 * `createV1RuntimePort` + `wireV1Rules` over a V1 hooks facade; durable rides
 * synthetic parts appended to the `chat.message` output, transient rides the
 * messages-transform output appends, observations ride `tool.execute.*`.
 *
 * Both paths share ONE rules directory (same absolute paths) so delivery
 * identities and ruleKeys are comparable. Scenarios describe events
 * host-agnostically; each path converts them to its own hook shapes so both
 * paths receive the same logical event. Collected deliveries must be
 * identical (spec D6).
 */
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearRuleCache } from '../../../src/rules-engine/rules/rule-discovery.js';
import {
  createMockPluginInput,
  createMockRuntimePort,
} from '../../../src/rules-engine/test-fixtures.js';
import { createRuntime } from '../../../src/rules-engine/runtime/create-runtime.js';
import { createV1RuntimePort, wireV1Rules } from '../../../src/rules-engine/runtime/v1-adapter.js';

export interface ParityDelivery {
  /** Text of every durable delivery part, in delivery order. */
  durableText: string[];
  /** ruleKeys/hookKeys of every durable delivery part, in delivery order. */
  durableMetadata: Array<{ ruleKeys?: string[]; hookKeys?: string[] }>;
  /** Text of every appended transient rule message, in append order. */
  transientText: string[];
}

/** A rule file written into the shared global rules directory. */
export interface RuleFile {
  name: string;
  content: string;
}

/** Host-agnostic context message; converted per path inside the harness. */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/** Path-independent event entry points; each fires the same logical event. */
export interface ParityEvents {
  toolAfter(input: {
    tool: string;
    sessionID: string;
    id: string;
    input: Record<string, unknown>;
    result?: { output?: unknown; content?: unknown };
  }): Promise<void>;
  prompt(input: { sessionID: string; messageID: string; text: string }): Promise<void>;
  context(input: {
    sessionID: string;
    messages: ContextMessage[];
    tools?: Record<string, unknown>;
    agent?: string;
    model?: { id?: string; providerID?: string };
  }): Promise<void>;
}

/** A runnable scenario: rule files plus a path-agnostic event body. */
export interface ParityScenario {
  name: string;
  rules: RuleFile[];
  /** Optional per-session stage provider, wired into both runtimes. */
  getCurrentStage?: (sessionID: string) => Promise<string | undefined>;
  run(events: ParityEvents, sessionID: string): Promise<void>;
}

interface ScenarioSetup {
  testDir: string;
  globalRulesDir: string;
  sessionID: string;
  prevConfigDir: string | undefined;
}

function setupScenario(scenario: ParityScenario): ScenarioSetup {
  const testDir = mkdtempSync(path.join(tmpdir(), 'parity-'));
  const globalRulesDir = path.join(testDir, '.config', 'opencode', 'rules');
  mkdirSync(globalRulesDir, { recursive: true });
  for (const rule of scenario.rules) {
    writeFileSync(path.join(globalRulesDir, rule.name), rule.content);
  }
  return {
    testDir,
    globalRulesDir,
    sessionID: `ses_${scenario.name.replace(/\W+/g, '_')}`,
    prevConfigDir: process.env.XDG_CONFIG_HOME,
  };
}

function teardownScenario(setup: ScenarioSetup): void {
  // Restore the caller's config dir before removing the temp tree.
  if (setup.prevConfigDir === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = setup.prevConfigDir;
  rmSync(setup.testDir, { recursive: true, force: true });
}

/** Runs one path of a scenario and returns its collected deliveries. */
export type ParityPath = 'v1' | 'v2';

interface TextPartLike {
  id?: string;
  type?: string;
  text?: unknown;
  synthetic?: boolean;
  metadata?: { ruleKeys?: string[]; hookKeys?: string[] };
}

interface HostMessageLike {
  info?: { id?: unknown; role?: unknown; sessionID?: unknown };
  id?: unknown;
  role?: unknown;
  parts?: TextPartLike[];
  content?: TextPartLike[];
}

function partsText(parts: TextPartLike[]): string[] {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
}

/** Durable deliveries normalized for parity: ruleAdmission is a per-path
 *  mechanism marker (V1 flushes via the durable turn, V2 via an admission
 *  synthetic), not delivery content, so it is stripped before comparison. */
function normalizedMetadata(
  parts: ReadonlyArray<{ metadata?: Record<string, unknown> }>
): Array<{ ruleKeys?: string[]; hookKeys?: string[] }> {
  return parts
    .filter((part) => part.metadata !== undefined)
    .map((part) => {
      const metadata = part.metadata!;
      return {
        ...(Array.isArray(metadata.ruleKeys) ? { ruleKeys: metadata.ruleKeys } : {}),
        ...(Array.isArray(metadata.hookKeys) ? { hookKeys: metadata.hookKeys } : {}),
      };
    });
}

function partsMetadata(parts: TextPartLike[]): Array<{ ruleKeys?: string[]; hookKeys?: string[] }> {
  return normalizedMetadata(
    parts.filter((part) => part.metadata !== undefined) as Array<{
      metadata?: Record<string, unknown>;
    }>
  );
}

/**
 * Extracts text parts from host messages, accepting both host shapes:
 * v1/transform `{ info, parts }` legacy messages and v2 AI SDK
 * `{ id, role, content }` messages appended by the session context hook.
 */
function appendedMessagesText(messages: HostMessageLike[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    const parts = message.parts ?? null;
    const content = message.content ?? null;
    const source = parts ?? content ?? [];
    for (const part of source) {
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text as string);
      }
    }
  }
  return texts;
}

/** Converts host-agnostic messages to the v2 AI SDK shape consumed by the session context hook. */
function toV2ContextMessages(messages: readonly ContextMessage[]): Array<Record<string, unknown>> {
  return messages.map((message, index) => ({
    id: `msg_c_${index}`,
    role: message.role,
    content: [{ type: 'text', text: message.text }],
  }));
}

/** Converts host-agnostic messages to the v1 transform `{ info, parts }` shape. */
function toV1TransformMessages(
  messages: readonly ContextMessage[],
  sessionID: string
): Array<Record<string, unknown>> {
  return messages.map((message, index) => ({
    info: {
      id: `msg_c_${index}`,
      sessionID,
      role: message.role,
      time: { created: 1 },
      agent: 'code',
      model: { providerID: 'test', modelID: 'model' },
    },
    parts: [{ id: `part_c_${index}`, type: 'text', text: message.text, synthetic: false }],
  }));
}

/** Runs the scenario over the V2 host adapter path. */
async function runV2(scenario: ParityScenario, setup: ScenarioSetup): Promise<ParityDelivery> {
  process.env.XDG_CONFIG_HOME = path.join(setup.testDir, '.config');
  clearRuleCache();
  const mock = createMockPluginInput({ testDir: setup.testDir });
  const runtime = await createRuntime({
    port: createMockRuntimePort(mock),
    directory: setup.testDir,
    projectDirectory: setup.testDir,
    ...(scenario.getCurrentStage ? { getCurrentStage: scenario.getCurrentStage } : {}),
  });
  await runtime.wire(mock.context);

  let transientText: string[] = [];
  const events: ParityEvents = {
    toolAfter: async (input) => {
      await mock.hooks.toolAfter[0]?.({
        tool: input.tool,
        sessionID: input.sessionID,
        id: input.id,
        input: input.input,
        status: 'completed',
        result: input.result,
      });
    },
    prompt: async (input) => {
      await mock.hooks.sessionPrompt[0]?.({
        sessionID: input.sessionID,
        messageID: input.messageID,
        prompt: { text: input.text },
      });
    },
    context: async (input) => {
      transientText = [];
      const hostMessages = toV2ContextMessages(input.messages);
      const before = hostMessages.length;
      await mock.hooks.sessionContext[0]?.({
        sessionID: input.sessionID,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        messages: hostMessages,
      });
      transientText = appendedMessagesText(hostMessages.slice(before) as never);
    },
  };
  await scenario.run(events, setup.sessionID);

  const durableText = mock.syntheticCalls.map((call) => call.text);
  const durableMetadata = normalizedMetadata(
    mock.syntheticCalls as Array<{ metadata?: Record<string, unknown> }>
  );

  return {
    durableText,
    durableMetadata,
    transientText,
  };
}

/**
 * Runs the scenario over the V1 host adapter path.
 *
 * The V1 hooks object starts empty and is layered exactly like production:
 * `createV1RuntimePort` wraps `chat.message` first, then `wireV1Rules` wraps
 * hook->runtime wiring on top. `persistViaChat` therefore needs an active
 * `chat.message` output: an observation admission is queued and flushed on
 * the next prompt turn, which mirrors the real V1 host.
 */
async function runV1(scenario: ParityScenario, setup: ScenarioSetup): Promise<ParityDelivery> {
  process.env.XDG_CONFIG_HOME = path.join(setup.testDir, '.config');
  clearRuleCache();
  const hooks: Record<string, unknown> = {
    'chat.message': async () => {},
    'experimental.chat.messages.transform': async () => {},
    'tool.execute.before': async () => {},
    'tool.execute.after': async () => {},
  };
  const runtime = await createRuntime({
    port: createV1RuntimePort({
      hooks: hooks as never,
      client: null,
      directory: setup.testDir,
    }),
    directory: setup.testDir,
    projectDirectory: setup.testDir,
    ...(scenario.getCurrentStage ? { getCurrentStage: scenario.getCurrentStage } : {}),
  });
  const cleanup = await wireV1Rules(runtime, hooks as never);

  const durableParts: TextPartLike[] = [];
  let transientText: string[] = [];

  const after = hooks['tool.execute.after'] as (input: unknown, output: unknown) => Promise<void>;
  const chat = hooks['chat.message'] as (
    input: unknown,
    output: { message: { id: string }; parts: TextPartLike[] }
  ) => Promise<void>;
  const transform = hooks['experimental.chat.messages.transform'] as (
    input: unknown,
    output: { messages: Array<Record<string, unknown>> }
  ) => Promise<void>;

  const events: ParityEvents = {
    toolAfter: async (input) => {
      // The V1 host fires tool.execute.after with its own two-arg shape; the
      // adapter converts it to the v2 core contract.
      await after(
        {
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.id,
          args: input.input,
        },
        {
          title: input.tool,
          output: typeof input.result?.output === 'string' ? input.result.output : '',
          metadata: undefined,
        }
      );
    },
    prompt: async (input) => {
      const output: { message: { id: string }; parts: TextPartLike[] } = {
        message: { id: input.messageID },
        parts: [{ id: 'part_user', type: 'text', text: input.text, synthetic: false }],
      };
      const before = output.parts.length;
      await chat({ sessionID: input.sessionID, messageID: input.messageID }, output);
      durableParts.push(...output.parts.slice(before));
    },
    context: async (input) => {
      transientText = [];
      const output = { messages: toV1TransformMessages(input.messages, input.sessionID) };
      const before = output.messages.length;
      await transform({ sessionID: input.sessionID }, output);
      transientText = appendedMessagesText(output.messages.slice(before) as never);
    },
  };
  await scenario.run(events, setup.sessionID);
  await cleanup();

  return {
    durableText: partsText(durableParts),
    durableMetadata: partsMetadata(durableParts),
    transientText,
  };
}

export interface ParityResult {
  v1: ParityDelivery;
  v2: ParityDelivery;
}

/** Runs a scenario on both paths against the SAME rules directory. */
export async function runBothPaths(scenario: ParityScenario): Promise<ParityResult> {
  const setup = setupScenario(scenario);
  try {
    const v1 = await runV1(scenario, setup);
    const v2 = await runV2(scenario, setup);
    return { v1, v2 };
  } finally {
    teardownScenario(setup);
  }
}

/** Golden assertion on the V2 (reference) record; catches a common bug in both paths. */
export function expectGolden(
  delivery: ParityDelivery,
  expected: { durable?: string[]; transient?: string[] }
): void {
  for (const fragment of expected.durable ?? []) {
    if (delivery.durableText.length === 0) {
      throw new Error(
        `golden: expected durable delivery containing ${JSON.stringify(fragment)}, got none`
      );
    }
    if (!delivery.durableText.some((text) => text.includes(fragment))) {
      throw new Error(`golden: no durable delivery contains ${JSON.stringify(fragment)}`);
    }
  }
  for (const fragment of expected.transient ?? []) {
    if (delivery.transientText.length === 0) {
      throw new Error(
        `golden: expected transient delivery containing ${JSON.stringify(fragment)}, got none`
      );
    }
    if (!delivery.transientText.some((text) => text.includes(fragment))) {
      throw new Error(`golden: no transient delivery contains ${JSON.stringify(fragment)}`);
    }
  }
}

/** Host-agnostic user message helper for scenario bodies. */
export function userMessage(text: string): ContextMessage {
  return { role: 'user', text };
}
