/**
 * The internal seam of every smoke host: what a V1 or V2 strategy must do, and the one
 * place where host-specific payloads become the shared normalized smoke types.
 *
 * A transport strategy knows endpoints, the generated client, auth, questions and forms.
 * Nothing above it does. The facade hides which strategy is in use, and the runner and the
 * scenarios see only the shared types in `host/types.ts`.
 */

import { readWorkflowSession, type Host } from '../harness.ts';
import type {
  NormalizedInteraction,
  NormalizedPart,
  NormalizedToolCall,
  NormalizedTurn,
  PluginObservation,
  PromptInput,
  PromptResult,
  SmokeSession,
  SmokeWorkflowState,
} from './types.ts';

/**
 * The plugin registers its own tool surface under this prefix, so a call to one of its
 * tools is the observable proof that the plugin loaded. Nothing else about the host tells
 * a plugin tool apart from a built-in one.
 */
export const PLUGIN_TOOL_PREFIX = 'workflow-';

/** The tag the plugin puts on its own consent requests, whichever transport carries it. */
export const CONSENT_TAG = '<consent-request';

/**
 * Shared name for the host's shell-command tool.
 *
 * V1 reports it as `bash`, V2 as `shell`, and both mean the same capability. The shared model
 * uses one name so a scenario can assert "a shell command ran" without branching by host.
 */
export const SHELL_TOOL = 'shell';

const TOOL_ALIASES: Record<string, string> = { bash: SHELL_TOOL, shell: SHELL_TOOL };

/** The shared name of a host tool, for capabilities both hosts name differently. */
export function sharedToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

export function hasConsentTag(text: string): boolean {
  return text.includes(CONSENT_TAG);
}

/** Whether a reported tool name belongs to the plugin's own tool surface. */
export function isPluginTool(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(PLUGIN_TOOL_PREFIX);
}

/** What one transport strategy must offer the facade. Internal: scenarios never see it. */
export interface HostTransport {
  createSession(title: string): Promise<SmokeSession>;
  prompt(session: SmokeSession, input: PromptInput): Promise<PromptResult>;
  readWorkflowState(session: SmokeSession): Promise<SmokeWorkflowState | null>;
  removeSession(session: SmokeSession): Promise<void>;
}

/** Untrusted host payload read field by field; a declared type never validates JSON. */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Text a tool result carried, whichever of the host's content shapes holds it. */
function toolOutput(state: Record<string, unknown>): string | undefined {
  const content = state.content;
  if (typeof state.output === 'string' && state.output !== '') return state.output;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => fields(entry))
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string)
    .join('\n');
  return text === '' ? undefined : text;
}

/** Error text a tool result carried, under either name the two hosts use for it. */
function toolError(state: Record<string, unknown>): string | undefined {
  if (typeof state.error === 'string' && state.error !== '') return state.error;
  const nested = fields(state.error);
  return typeof nested.message === 'string' && nested.message !== '' ? nested.message : undefined;
}

/**
 * The command a shell call ran.
 *
 * Both hosts state it under `state.input.command` — V1 verbatim with its `workdir`, V2 with the
 * command alone — so the shared model can carry the actual command without knowing which host
 * reported it.
 */
function toolCommand(state: Record<string, unknown>): string | undefined {
  const command = fields(state.input).command;
  return typeof command === 'string' && command !== '' ? command : undefined;
}

export function normalizeToolStatus(status: unknown): NormalizedToolCall['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'pending':
    case 'running':
      return 'pending';
    default:
      return 'unknown';
  }
}

/**
 * One assistant part as the V1 message response reports it: `tool` names the call and
 * `state` carries its outcome. Model reasoning is dropped: it is not something the host
 * did, and no assertion may rest on prose the model wrote about itself.
 */
export function normalizeLegacyPart(value: unknown): NormalizedPart | undefined {
  const part = fields(value);
  const state = fields(part.state);
  const text = typeof part.text === 'string' ? part.text : undefined;
  if (part.type === 'reasoning') return undefined;
  if (part.type === 'tool' && typeof part.tool === 'string') {
    const output = toolOutput(state);
    const error = toolError(state);
    const command = toolCommand(state);
    return {
      kind: 'tool',
      tool: sharedToolName(part.tool),
      status: normalizeToolStatus(state.status),
      ...(command === undefined ? {} : { command }),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
    };
  }
  if (part.type === 'text' && text !== undefined) return { kind: 'text', text };
  return { kind: 'unknown', ...(text === undefined ? {} : { text }) };
}

/**
 * Every normalized part one V2 assistant content entry produces.
 *
 * A V2 host may run plugin tools through one generic tool of its own and report, in the
 * part metadata, which plugin tools actually ran. That wrapper is a host detail, so the
 * normalized calls carry the plugin tool names and stay comparable with V1.
 */
export function normalizeSessionContent(value: unknown): NormalizedPart[] {
  const content = fields(value);
  const text = typeof content.text === 'string' ? content.text : undefined;
  if (content.type === 'reasoning') return [];
  if (content.type === 'tool') {
    const state = fields(content.state);
    const output = toolOutput(state);
    const error = toolError(state);
    const status = normalizeToolStatus(state.status);
    const reported = pluginCallsOf(state);
    const names =
      reported.length > 0
        ? reported
        : [sharedToolName(typeof content.name === 'string' ? content.name : 'unknown')];
    const command = toolCommand(state);
    return names.map((name) => ({
      kind: 'tool',
      tool: name,
      status,
      ...(command === undefined ? {} : { command }),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
    }));
  }
  if (content.type === 'text' && text !== undefined) return [{ kind: 'text', text }];
  return [{ kind: 'unknown', ...(text === undefined ? {} : { text }) }];
}

/**
 * The plugin tools a V2 host ran inside one generic tool call.
 *
 * The part metadata is the authoritative report. A host build that states only the code it
 * executed is read for the same names, because the wrapper hands the plugin tools to the
 * model as `tools["name"]`.
 */
function pluginCallsOf(state: Record<string, unknown>): string[] {
  const reported = fields(state.metadata).toolCalls;
  if (Array.isArray(reported)) {
    const names = reported.map((call) => fields(call).tool).filter(isPluginTool);
    if (names.length > 0) return names;
  }
  const code = fields(state.input).code;
  if (typeof code !== 'string') return [];
  return [...code.matchAll(/tools\[\s*["']([^"']+)["']\s*\]/gu)]
    .map((match) => match[1])
    .filter(isPluginTool);
}

/** Drop entries the host reported but the shared model has no shape for. */
export function compactParts(parts: Array<NormalizedPart | undefined>): NormalizedPart[] {
  return parts.filter((part): part is NormalizedPart => part !== undefined);
}

/** One host message, reduced to what the turn boundary needs. */
export interface OrderedMessage {
  role: unknown;
  /** Timestamp the host itself wrote; array order is not promised by either API. */
  createdAt: number;
  items: unknown[];
}

/**
 * Items of the assistant messages the last user instruction produced.
 *
 * The last user message is the boundary, and host timestamps order the list under either
 * array direction, so the instruction's own output is unambiguous.
 */
export function itemsAfterLastUser(messages: OrderedMessage[]): unknown[] {
  const ordered = [...messages].sort((left, right) => left.createdAt - right.createdAt);
  let boundary = -1;
  ordered.forEach((message, index) => {
    if (message.role === 'user') boundary = index;
  });
  return ordered
    .slice(boundary + 1)
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.items);
}

/** Infer the call outcome when the host reported only its result, never its status. */
function partStatus(part: Extract<NormalizedPart, { kind: 'tool' }>): NormalizedToolCall['status'] {
  if (part.status !== undefined && part.status !== 'unknown') return part.status;
  if (part.error !== undefined) return 'failed';
  return part.output === undefined ? 'unknown' : 'completed';
}

export function toolCallsFromParts(parts: NormalizedPart[]): NormalizedToolCall[] {
  return parts
    .filter((part): part is Extract<NormalizedPart, { kind: 'tool' }> => part.kind === 'tool')
    .map((part) => ({
      name: part.tool,
      status: partStatus(part),
      ...(part.command === undefined ? {} : { command: part.command }),
      ...(part.output === undefined ? {} : { output: part.output }),
      ...(part.error === undefined ? {} : { error: part.error }),
    }));
}

export function transcriptFromParts(parts: NormalizedPart[], error = ''): string {
  const lines = parts
    .map((part) => {
      switch (part.kind) {
        case 'text':
          return part.text;
        case 'tool':
          return [`«tool:${part.tool}»`, part.output ?? '', part.error ?? '']
            .filter((entry) => entry !== '')
            .join(' ');
        case 'error':
          return part.error;
        default:
          return part.text ?? '';
      }
    })
    .filter((line) => line !== '');
  return [error, ...lines].filter((line) => line !== '').join('\n');
}

/**
 * What the host showed about the plugin itself.
 *
 * `observedPluginTools` and `loaded` are read from the tool names the host reported as called:
 * a `workflow-*` call can only come from the plugin, so observing one is what separates
 * "the plugin loaded" from "the prompt finished without an error". That is the whole
 * observable extent of it — no host hands the suite a list of registered tools.
 *
 * `hostOperation` is not derived from this evidence: it is the caller's claim about where the
 * evidence came from, and only a transport strategy that drove a live host states `'real-host'`.
 */
export function pluginObservationFrom(
  toolCalls: NormalizedToolCall[],
  turnStatus: NormalizedTurn['status'],
  hostOperation: PluginObservation['hostOperation'] = 'unknown'
): PluginObservation {
  const pluginTools = [...new Set(toolCalls.map((call) => call.name).filter(isPluginTool))];
  const failed = turnStatus === 'failed' || toolCalls.some((call) => call.status === 'failed');
  return {
    loaded: pluginTools.length > 0,
    observedPluginTools: pluginTools,
    invokedTools: toolCalls,
    hostOperation,
    result: failed
      ? 'error'
      : toolCalls.some((call) => call.status === 'completed')
        ? 'success'
        : 'unknown',
  };
}

export interface TurnEvidence {
  status: NormalizedTurn['status'];
  parts: NormalizedPart[];
  /** Error the host reported for the turn itself, not for a tool. */
  error?: string;
  /** The host is still waiting for an operator decision this turn produced. */
  pendingInteraction?: boolean;
  /** Interactions this turn answered through the facade. */
  interactions?: NormalizedInteraction[];
  /** Operator answers and timeouts worth carrying into the step's evidence. */
  notes?: string[];
}

/**
 * Bind one turn to the observable workflow state it left behind. The plugin evidence is
 * derived here, so no scenario can claim a loaded plugin from a prompt that merely ended.
 *
 * `hostOperation` is stated by the caller and never by this builder: only a transport strategy
 * that drove a live `opencode serve` may say `'real-host'`, while anything that cannot point at
 * a started host — a fake adapter, a synthesized observation — says `'unknown'`. Because the
 * claim is an explicit argument, a new adapter cannot inherit it by accident.
 */
export function buildPromptResult(
  evidence: TurnEvidence,
  workflowState: SmokeWorkflowState | null,
  hostOperation: PluginObservation['hostOperation']
): PromptResult {
  const toolCalls = toolCallsFromParts(evidence.parts);
  const transcript = [
    ...(evidence.notes ?? []),
    transcriptFromParts(evidence.parts, evidence.error),
  ]
    .filter((entry) => entry !== '')
    .join('\n');
  return {
    turn: {
      status: evidence.status,
      transcript,
      parts: evidence.parts,
      toolCalls,
      ...(evidence.pendingInteraction ? { pendingInteraction: true } : {}),
    },
    workflowState,
    pluginEvidence: pluginObservationFrom(toolCalls, evidence.status, hostOperation),
    ...(evidence.interactions === undefined ? {} : { interactions: evidence.interactions }),
  };
}

function normalizeWorkflowStatus(value: unknown): SmokeWorkflowState['status'] | undefined {
  switch (value) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
      return value;
    default:
      return undefined;
  }
}

function normalizeTasks(value: unknown): Record<string, Array<{ status?: string }>> | undefined {
  const lists = fields(value);
  const tasks: Record<string, Array<{ status?: string }>> = {};
  let seen = false;
  for (const [key, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) continue;
    seen = true;
    tasks[key] = list.map((task) => {
      const status = fields(task).status;
      return typeof status === 'string' ? { status } : {};
    });
  }
  return seen ? tasks : undefined;
}

/** Document references the plugin recorded, with non-string values dropped. */
function normalizeRefs(value: unknown): Record<string, string> | undefined {
  const refs = fields(value);
  const normalized: Record<string, string> = {};
  let seen = false;
  for (const [key, entry] of Object.entries(refs)) {
    if (typeof entry !== 'string') continue;
    seen = true;
    normalized[key] = entry;
  }
  return seen ? normalized : undefined;
}

/**
 * Narrow the plugin's persisted session into the shared workflow state.
 *
 * `null` means one thing only: the store holds no session for this host session, which is the
 * observable proof that a mutating instruction applied no durable mutation. Anything else the
 * store holds — an unparsable payload, an array, a value without any of the plugin's own
 * session fields — is not "no session": it is a store the run cannot vouch for, so it is
 * refused here and the caller reports the outcome as unknown instead of as absent.
 */
export function normalizeWorkflowState(sessionId: string, raw: unknown): SmokeWorkflowState | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `[ERROR] сохранённый payload сессии ${sessionId} не является сессией workflow: ${describePayload(raw)}`
    );
  }
  const session = fields(raw);
  if (!SESSION_FIELDS.some((field) => field in session)) {
    throw new Error(
      `[ERROR] сохранённый payload сессии ${sessionId} не содержит ни одного поля сессии workflow: ${describePayload(raw)}`
    );
  }
  const stage = typeof session.currentStage === 'string' ? session.currentStage : undefined;
  const tasks = normalizeTasks(session.tasks);
  const refs = normalizeRefs(session.refs);
  return {
    sessionId,
    status:
      normalizeWorkflowStatus(session.status) ?? (stage === undefined ? 'unknown' : 'running'),
    ...(stage === undefined ? {} : { currentStage: stage }),
    ...(tasks === undefined ? {} : { tasks }),
    ...(refs === undefined ? {} : { refs }),
    durableMutation: 'applied',
  };
}

/**
 * Fields the plugin's own session always carries. A payload without any of them cannot be
 * confirmed as this suite's session, so it is reported as an unreadable store.
 */
const SESSION_FIELDS = ['sessionId', 'currentStage', 'status', 'tasks'] as const;

/** A short, safe description of an unexpected payload for the failure evidence. */
function describePayload(raw: unknown): string {
  if (typeof raw === 'string') return `строка (${raw.slice(0, 80)})`;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) return `массив из ${raw.length}`;
  return JSON.stringify(raw).slice(0, 120);
}

/**
 * Read the durable workflow state through the host's own store. Shared by both strategies
 * because the plugin writes one store, whichever API the scenario drove it through.
 */
export async function readNormalizedWorkflowState(
  host: Host,
  sessionId: string
): Promise<SmokeWorkflowState | null> {
  return normalizeWorkflowState(sessionId, await readWorkflowSession(host, sessionId));
}
