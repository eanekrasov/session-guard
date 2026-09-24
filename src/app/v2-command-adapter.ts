import type { Context } from '@opencode/plugin/promise/plugin';
import type { CommandInvocation } from '@opencode/plugin/promise/command';
import type { Registration } from '@opencode/plugin/promise/registration';
import { Agent } from '@opencode/schema/agent';

// ─── Public contract ──────────────────────────────────────────────────────────

/**
 * V2 адаптер для бывшей V1 config surface.
 *
 * V1 `handleConfig` регистрировал sm-* команды и агента session-guard через
 * мутацию Config.command / Config.agent. V2 заменяет это на декларативные
 * transform-редакторы в `ctx.command` и `ctx.agent`.
 *
 * Production integration is owned by setupV2Runtime, which also owns cleanup.
 */

// ─── V1 config surface (reference) ────────────────────────────────────────────

/**
 * Команды, которые V1 handleConfig регистрировал через config.command.
 * Каждая команда — дескриптор с template (prompt), description и agent.
 *
 * V2 CommandDefinition.execute receives the full invocation context. The V1
 * commands remain prompt-driven: execution forwards the configured template to
 * the host session prompt rather than implementing command-specific workflow
 * mutations here.
 */
export interface V1CommandDescriptor {
  readonly name: string;
  readonly description: string;
  /** V1 template — переносится как prompt по умолчанию, пока execute не реализован */
  readonly template: string;
}

/**
 * All sm-* commands that V1 handleConfig registered.
 */
export const V1_SM_COMMANDS: readonly V1CommandDescriptor[] = [
  {
    name: 'sm-status',
    description: 'Show the current session-guard workflow session status',
    template: 'tell the user the current session-guard workflow status for this session',
  },
  {
    name: 'sm-list',
    description: 'List all active workflow sessions',
    template: 'list all session-guard workflow sessions and their stages',
  },
  {
    name: 'sm-session',
    description: 'Create, switch, or inspect a workflow session',
    template: 'manage the session-guard workflow session: create, switch, or show details',
  },
  {
    name: 'sm-profile',
    description: 'Switch the active workflow profile',
    template:
      'switch the session-guard profile: shows available profiles or switches to a given profile ID',
  },
];

/**
 * Агент session-guard, которого V1 handleConfig регистрировал через config.agent.
 */
export interface V1AgentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: 'subagent';
  readonly color: string;
}

export const V1_SESSION_GUARD_AGENT: V1AgentDescriptor = {
  id: 'session-guard',
  name: 'session-guard',
  description:
    'State machine workflow agent — manages sessions, profiles, stages, and gates. Use for sm-* commands.',
  mode: 'subagent',
  color: '#6366F1',
};

// ─── V2 adapter types ─────────────────────────────────────────────────────────

/**
 * Результат регистрации V2 команд и агента.
 * Интегратор владеет жизненным циклом registrations.
 */
export interface V2CommandAdapterResult {
  /** Registrations, которые нужно dispose при cleanup */
  readonly registrations: readonly Registration[];
}

// ─── Scope limits ─────────────────────────────────────────────────────────────

/**
 * The command adapter deliberately does not implement command-specific
 * workflow mutations or connect the V2 agent catalog. Those are outside this
 * parity slice. V1 command templates are forwarded unchanged.
 */
export const V2_COMMAND_ADAPTER_BLOCKERS: string[] = [
  'command-specific execute workflow mutations remain outside prompt-driven parity',
  'V2 AgentEditor exposes no resolved config.model on Context; the agent keeps the host default model',
];

// ─── Mapper: V1 commands → V2 CommandDefinition names ─────────────────────────

/**
 * Map a V1 descriptor to the V2 command metadata.
 */
export function v1CommandToV2Definition(v1: V1CommandDescriptor): {
  readonly name: string;
  readonly description: string;
} {
  return {
    name: v1.name,
    description: v1.description,
  };
}

function forwardV1Prompt(
  ctx: Context,
  command: V1CommandDescriptor,
  invocation: CommandInvocation
): Promise<void> {
  return ctx.session
    .prompt({
      sessionID: invocation.sessionID,
      text: command.template,
      delivery: invocation.delivery,
    })
    .then(() => undefined);
}

/** Register the V1 prompt-driven commands through the confirmed V2 API. */
export async function registerV2Commands(ctx: Context): Promise<Registration> {
  return ctx.command.transform((editor) => {
    for (const v1 of V1_SM_COMMANDS) {
      editor.add({
        name: v1.name,
        description: v1.description,
        execute: (invocation) => forwardV1Prompt(ctx, v1, invocation),
      });
    }
  });
}

/**
 * Register the V1 session-guard agent through the confirmed V2 agent editor.
 * AgentEditor.update also materializes a missing agent with V2 defaults.
 * V2 does not expose the V1 resolved config.model on Context, so model is
 * intentionally left at the host default rather than guessed.
 */
export async function registerV2Agent(ctx: Context): Promise<Registration> {
  return ctx.agent.transform((editor) => {
    editor.update(V1_SESSION_GUARD_AGENT.id, (agent) => {
      agent.name = Agent.Name.make(V1_SESSION_GUARD_AGENT.name);
      agent.description = V1_SESSION_GUARD_AGENT.description;
      agent.mode = V1_SESSION_GUARD_AGENT.mode;
      agent.color = V1_SESSION_GUARD_AGENT.color;
    });
  });
}

/**
 * Фабрика для адаптера V2 команд/каталога.
 *
 * Registers the command surface and returns registrations for cleanup. Agent
 * catalog integration remains deliberately separate from this slice.
 *
 * @returns V2CommandAdapterResult с registrations для cleanup.
 */
export async function createV2CommandAdapter(ctx: Context): Promise<V2CommandAdapterResult> {
  const registrations: Registration[] = [];

  const commandReg = await registerV2Commands(ctx);
  registrations.push(commandReg);

  return { registrations };
}
