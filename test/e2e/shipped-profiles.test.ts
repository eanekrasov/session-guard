import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { resolveConfig } from '../../src/public-api.ts';
import { mergeSchemasToEngineConfig } from '../../src/app/mutation-orchestrator.ts';
import type { StageDef } from '../../src/schema/types.ts';

const PROFILES_DIR = path.resolve(import.meta.dirname, '../../profiles');

async function engineConfigFor(profileId: string) {
  const profile = await resolveConfig(profileId, PROFILES_DIR);
  return { profile, config: mergeSchemasToEngineConfig(profile.schemas) };
}

function stage(config: { stages?: Record<string, StageDef> }, id: string): StageDef | undefined {
  return config.stages?.[id];
}

describe('shipped profiles', () => {
  it.each(['base', 'harness', 'android'])('%s resolves into a usable engine config', async (id) => {
    const { config } = await engineConfigFor(id);
    expect(Object.keys(config.stages ?? {})).toContain('commit');
    expect(config.transitions.length).toBeGreaterThan(0);
  });

  it.each(['base', 'harness', 'android'])(
    '%s inherits the base transition set intact',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const edges = config.transitions.map((t) => `${t.from}→${t.to}`);
      expect(edges).toEqual(
        expect.arrayContaining([
          'planning→tasks_ready',
          'tasks_ready→execution',
          'execution→validation',
          'validation→commit',
          'validation→execution',
          'validation→failed',
          'commit→done',
        ])
      );
    }
  );

  it.each(['base', 'harness', 'android'])(
    '%s runs code and verify inside the execution loop',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const execution = config.stages?.execution;
      expect(execution?.loop, 'execution does not cycle over a task list').toBe('implementation');

      const nested = Object.keys(execution?.stages ?? {});
      expect(nested).toEqual(['code', 'verify']);

      // The verifier stage declares what it waits for; both agents report into it.
      expect(execution?.stages?.verify?.gates).toEqual(['review', 'qa']);

      const inner = (execution?.transitions ?? []).map((t) => `${t.from}→${t.to}`);
      expect(inner).toEqual(expect.arrayContaining(['code→verify', 'verify→code']));

      // A failed task spends its own budget, never a session-wide counter.
      const backToCode = execution?.transitions?.find(
        (t) => t.from === 'verify' && t.to === 'code'
      );
      expect(backToCode?.effects?.[0]?.bumpRetry).toBe('task.id');
    }
  );

  it.each(['base', 'harness', 'android'])('%s requires an approved plan to edit', async (id) => {
    const { config } = await engineConfigFor(id);
    expect(config.actionGuards?.beginMutation).toBe("session.approved('plan')");
  });

  it.each(['base', 'harness', 'android'])(
    '%s advances out of commit on the receipt, never the permit',
    async (id) => {
      const { config } = await engineConfigFor(id);
      const commitDone = config.transitions.find((t) => t.from === 'commit' && t.to === 'done');
      expect(commitDone?.guard).toBe('session.deliveryReceipt != null');
    }
  );

  it.each(['base', 'harness', 'android'])(
    '%s resolves agent rosters to names the host will report',
    async (id) => {
      const { config } = await engineConfigFor(id);
      // Synced agents register as `<profileId>/<name>`, so resolution qualifies
      // every roster entry. Bare names left here would never match a dispatch.
      for (const [stageId, def] of Object.entries(config.stages ?? {})) {
        for (const agent of def.allowedAgents ?? []) {
          expect(agent, `stage "${stageId}" of profile "${id}"`).toContain('/');
        }
        for (const [nestedId, nested] of Object.entries(def.stages ?? {})) {
          for (const agent of nested.allowedAgents ?? []) {
            expect(agent, `stage "${nestedId}" of profile "${id}"`).toContain('/');
          }
        }
      }
    }
  );

  it('harness and android stay distinguishable by their editing roles', async () => {
    const harness = await engineConfigFor('harness');
    const android = await engineConfigFor('android');
    expect(harness.profile.schemas.some((s) => s.editingAgents?.includes('harness'))).toBe(true);
    expect(android.profile.schemas.some((s) => s.editingAgents?.includes('figma'))).toBe(true);
  });

  it.each(['base', 'harness', 'android'])(
    '%s declares the gates its stages wait on',
    async (id) => {
      // The compiler checks a stage's `gates:` against this declaration, so a
      // profile that loses it on the way through resolution turns the check
      // off instead of failing it.
      const { config } = await engineConfigFor(id);
      expect(config.gates?.map((gate) => gate.id)).toEqual(['invariants', 'review', 'qa']);
    }
  );

  it.each(['base', 'harness', 'android'])('%s compiles without errors', async (id) => {
    const { compileWorkflow } = await import('../../src/schema/compile-workflow.ts');
    const { config, profile } = await engineConfigFor(id);
    const { errors } = compileWorkflow({
      source: profile.metadata.id,
      stages: config.stages,
      transitions: config.transitions,
      stageAssignments: config.stageAssignments,
      // Without this the compiler has no declaration to check a stage's
      // `gates:` against, and the gate-name check silently passes.
      gates: config.gates,
    });
    expect(errors, errors.map((e) => `${e.path}: ${e.message}`).join('\n')).toEqual([]);
  });

  it('every stage agent restriction names an agent the profile ships', async () => {
    const { agentIsAllowed } = await import('../../src/app/agent-names.ts');
    for (const id of ['base', 'harness', 'android']) {
      const { profile, config } = await engineConfigFor(id);
      const shipped = profile.metadata.agents;

      // Rosters are compared the way the runtime compares them: a restriction
      // arrives qualified (`android/review`), the manifest lists bare names.
      const check = (stageId: string, def: { allowedAgents?: string[] }): void => {
        for (const agent of def.allowedAgents ?? []) {
          expect(
            agentIsAllowed(agent, shipped, id),
            `profile "${id}" restricts stage "${stageId}" to agent "${agent}", which it does not ship`
          ).toBe(true);
        }
      };

      for (const [stageId, def] of Object.entries(config.stages ?? {})) {
        check(stageId, def);
        for (const [nestedId, nested] of Object.entries(def.stages ?? {})) {
          check(`${stageId}/${nestedId}`, nested);
        }
      }
    }
  });
});
