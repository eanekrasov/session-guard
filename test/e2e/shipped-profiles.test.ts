import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { resolveConfig } from '../../src/public-api.ts';
import { mergeSchemasToEngineConfig } from '../../src/app/mutation-orchestrator.ts';
import type { PhaseDef } from '../../src/schema/types.ts';

const PROFILES_DIR = path.resolve(import.meta.dirname, '../../profiles');

async function engineConfigFor(profileId: string) {
  const profile = await resolveConfig(profileId, PROFILES_DIR);
  return { profile, config: mergeSchemasToEngineConfig(profile.schemas) };
}

function phase(config: { phases?: Record<string, PhaseDef> }, id: string): PhaseDef | undefined {
  return config.phases?.[id];
}

describe('shipped profiles', () => {
  it.each(['base', 'harness', 'android'])('%s resolves into a usable engine config', async (id) => {
    const { config } = await engineConfigFor(id);
    expect(Object.keys(config.phases ?? {})).toContain('commit');
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
          'tasks_ready→code',
          'code→review',
          'review→qa',
          'review→code',
          'qa→commit',
          'qa→code',
          'qa→failed',
          'commit→done',
        ])
      );
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
      for (const [phaseId, def] of Object.entries(config.phases ?? {})) {
        for (const agent of def.allowedAgents ?? []) {
          expect(agent, `phase "${phaseId}" of profile "${id}"`).toContain('/');
        }
        for (const stage of def.stages ?? []) {
          for (const agent of stage.allowedAgents ?? []) {
            expect(agent, `stage "${stage.id}" of profile "${id}"`).toContain('/');
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

  it('every phase agent restriction names an agent the profile ships', async () => {
    for (const id of ['base', 'harness', 'android']) {
      const { profile, config } = await engineConfigFor(id);
      const shipped = new Set(profile.metadata.agents);
      for (const [phaseId, def] of Object.entries(config.phases ?? {})) {
        for (const agent of def.allowedAgents ?? []) {
          expect(
            shipped.has(agent),
            `profile "${id}" restricts phase "${phaseId}" to agent "${agent}", which it does not ship`
          ).toBe(true);
        }
      }
    }
  });
});
